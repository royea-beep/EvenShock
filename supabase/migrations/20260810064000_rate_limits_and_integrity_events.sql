-- Two things the round protocol shipped without: a ceiling, and a way for us to
-- find out when it is being pushed against.

-- ============================================================== rate limiting
--
-- `open_round` had no limit at all. A loop against it costs rows, quota and
-- money, and none of that shows up as a gameplay bug — it shows up as a bill.
--
-- The limits live HERE rather than being passed in by the Edge Function, unlike
-- the outcome table. Outcomes are game rules and must have exactly one
-- definition; a rate limit is server policy, and a caller that could choose its
-- own limit is not limited. The function is the only thing that decides.
--
-- The numbers come from the animation, which is a hard floor on how fast a
-- round can legitimately complete. In FAST mode a round costs at minimum:
--
--   reveal 501ms + "Shoot!" 180ms + impact 200ms + advance fade 200ms ≈ 1.08s
--
-- before the player has moved a thumb. So 60 rounds/minute — one per second —
-- is already unreachable by someone playing perfectly with no human delay, and
-- 600/hour is roughly 1.5-2x the fastest sustained play a person could manage
-- for a solid hour. Tight enough to bound abuse, with no path to it from real
-- play. If a legitimate player ever trips these, the numbers are wrong and
-- should move — that is a bug report, not a cheat.

create table public.rate_buckets (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  action       text        not null,
  bucket       text        not null check (bucket in ('minute', 'hour')),
  window_start timestamptz not null,
  hits         integer     not null default 0,
  primary key (user_id, action, bucket, window_start)
);

comment on table public.rate_buckets is
  'Fixed-window counters. Service role only — no grants, and RLS on so a leaked key still reaches nothing.';

alter table public.rate_buckets enable row level security;
revoke all on public.rate_buckets from anon, authenticated;

-- ========================================================== integrity events
--
-- A commitment mismatch or a server/client outcome disagreement used to reach
-- console.error in the player's browser, which is the one place we can never
-- look. This table is where those go instead.
--
-- `source` matters and is never inferred. A server-detected event is a fact we
-- observed; a client-reported one is an unverified claim from a machine we do
-- not control, which can be forged or spammed. Both are worth having and they
-- are not the same evidence, so they are never merged into one column.

create table public.integrity_events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id    uuid references auth.users (id) on delete set null,

  kind text not null check (kind in (
    'commitment_mismatch',          -- client: reveal did not hash to the commitment
    'outcome_disagreement',         -- client: server verdict != shared rules
    'reveal_before_move',           -- client: open_round returned a move or nonce
    'move_changed_after_resolution',-- server: different move for a resolved round
    'expired_round_submission',     -- server: submit arrived after expiry
    'rate_limited'                  -- server: a ceiling was hit
  )),
  source text not null check (source in ('server', 'client')),

  match_id uuid,
  round_id bigint,
  detail   jsonb not null default '{}'::jsonb
);

comment on table public.integrity_events is
  'Append-only. Service role only. `source` distinguishes what we observed from what a client claimed.';
comment on column public.integrity_events.detail is
  'Investigation context. Must never carry the nonce or drawn move of an UNRESOLVED round — that would make this table a leak vector. Resolved-round values are already known to that player and are safe.';

alter table public.integrity_events enable row level security;
revoke all on public.integrity_events from anon, authenticated;

-- Queryable along the three axes an investigation actually starts from: what
-- just happened, what kind of thing keeps happening, and who it happened to.
create index integrity_events_recent_idx on public.integrity_events (created_at desc);
create index integrity_events_kind_idx   on public.integrity_events (kind, created_at desc);
create index integrity_events_user_idx   on public.integrity_events (user_id, created_at desc);

create or replace function public.log_integrity_event(
  p_user_id  uuid,
  p_kind     text,
  p_source   text,
  p_match_id uuid    default null,
  p_round_id bigint  default null,
  p_detail   jsonb   default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.integrity_events (user_id, kind, source, match_id, round_id, detail)
  values (p_user_id, p_kind, p_source, p_match_id, p_round_id, p_detail);
exception when others then
  -- Logging must never be the reason a round fails. A dropped event is a gap in
  -- the record; a raised exception here would be a broken game.
  null;
end $$;

revoke all on function public.log_integrity_event(uuid, text, text, uuid, bigint, jsonb)
  from public, anon, authenticated;

/**
 * Triage view: what has been happening, by kind, over a window.
 * `select * from public.integrity_summary('24 hours');`
 */
create or replace function public.integrity_summary(p_window interval default '24 hours')
returns table (kind text, source text, events bigint, users bigint, latest timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select e.kind, e.source, count(*), count(distinct e.user_id), max(e.created_at)
    from public.integrity_events e
   where e.created_at > now() - p_window
   group by e.kind, e.source
   order by count(*) desc;
$$;

revoke all on function public.integrity_summary(interval) from public, anon, authenticated;

-- ============================================================ the rate check

create or replace function public.take_rate_token(p_user_id uuid, p_action text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_per_minute int;
  v_per_hour   int;
  v_minute_hits int;
  v_hour_hits   int;
begin
  -- See the header: derived from the animation's floor on round duration.
  case p_action
    when 'open_match'       then v_per_minute := 30; v_per_hour := 200;
    when 'open_round'       then v_per_minute := 60; v_per_hour := 600;
    when 'submit'           then v_per_minute := 60; v_per_hour := 600;
    when 'report_integrity' then v_per_minute := 10; v_per_hour :=  60;
    else                         v_per_minute := 60; v_per_hour := 600;
  end case;

  -- Counted BEFORE the allow/deny decision, deliberately: a rejected request
  -- still costs us work, and letting refusals go uncounted would mean a
  -- spammer's limit resets as fast as they can hit it.
  insert into public.rate_buckets (user_id, action, bucket, window_start, hits)
  values (p_user_id, p_action, 'minute', date_trunc('minute', now()), 1)
  on conflict (user_id, action, bucket, window_start)
    do update set hits = public.rate_buckets.hits + 1
  returning hits into v_minute_hits;

  insert into public.rate_buckets (user_id, action, bucket, window_start, hits)
  values (p_user_id, p_action, 'hour', date_trunc('hour', now()), 1)
  on conflict (user_id, action, bucket, window_start)
    do update set hits = public.rate_buckets.hits + 1
  returning hits into v_hour_hits;

  -- Opportunistic prune, scoped to this user so it stays cheap and needs no
  -- scheduled job.
  delete from public.rate_buckets
   where user_id = p_user_id and window_start < now() - interval '3 hours';

  if v_minute_hits > v_per_minute or v_hour_hits > v_per_hour then
    perform public.log_integrity_event(
      p_user_id, 'rate_limited', 'server', null, null,
      jsonb_build_object(
        'action', p_action,
        'minute_hits', v_minute_hits, 'minute_limit', v_per_minute,
        'hour_hits', v_hour_hits, 'hour_limit', v_per_hour
      )
    );
    return false;
  end if;

  return true;
end $$;

revoke all on function public.take_rate_token(uuid, text) from public, anon, authenticated;

-- ================================================ wire into the round RPCs

create or replace function public.open_match(
  p_user_id   uuid,
  p_format    text,
  p_theme     text,
  p_fast_mode boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if not public.take_rate_token(p_user_id, 'open_match') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  insert into public.matches (user_id, format, player_score, opponent_score, result, status, theme, fast_mode)
  values (p_user_id, p_format, 0, 0, null, 'in_progress', p_theme, coalesce(p_fast_mode, false))
  returning id into v_id;

  return jsonb_build_object('match_id', v_id);
end $$;

revoke all on function public.open_match(uuid, text, text, boolean) from public, anon, authenticated;

create or replace function public.open_round(
  p_match_id   uuid,
  p_user_id    uuid,
  p_move       text,
  p_nonce      text,
  p_commitment text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.matches;
  v_round_number int;
  v_id bigint;
begin
  if not public.take_rate_token(p_user_id, 'open_round') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  select * into m from public.matches where id = p_match_id and user_id = p_user_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if m.status <> 'in_progress' then return jsonb_build_object('error', 'match_closed'); end if;

  delete from public.rounds
   where match_id = p_match_id and state = 'open' and expires_at < now();

  select coalesce(max(round_number), 0) + 1 into v_round_number
    from public.rounds where match_id = p_match_id;

  insert into public.rounds (
    match_id, user_id, round_number, opponent_choice, nonce, commitment, state, expires_at
  ) values (
    p_match_id, p_user_id, v_round_number, p_move, p_nonce, p_commitment, 'open',
    now() + interval '60 seconds'
  )
  returning id into v_id;

  return jsonb_build_object('round_id', v_id, 'round_number', v_round_number);
exception
  when unique_violation then
    return jsonb_build_object('error', 'round_already_open');
end $$;

revoke all on function public.open_round(uuid, uuid, text, text, text) from public, anon, authenticated;

create or replace function public.resolve_round(
  p_round_id    bigint,
  p_user_id     uuid,
  p_player_move text,
  p_outcomes    jsonb,
  p_wins_needed jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rd public.rounds;
  m  public.matches;
  v_outcome  text;
  v_player   int;
  v_opponent int;
  v_needed   int;
  v_complete boolean;
  v_result   text;
  v_claimed  int;
begin
  if not public.take_rate_token(p_user_id, 'submit') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  select * into rd from public.rounds where id = p_round_id and user_id = p_user_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;

  select * into m from public.matches where id = rd.match_id;

  if rd.state = 'resolved' then
    if rd.player_choice <> p_player_move then
      -- Not a retry. Someone is trying to change their move after seeing the
      -- result, which is the single most interesting thing this table records.
      perform public.log_integrity_event(
        p_user_id, 'move_changed_after_resolution', 'server', rd.match_id, rd.id,
        jsonb_build_object('recorded_move', rd.player_choice, 'attempted_move', p_player_move)
      );
      return jsonb_build_object('error', 'already_submitted');
    end if;
    v_outcome := rd.outcome;

  elsif rd.expires_at <= now() then
    perform public.log_integrity_event(
      p_user_id, 'expired_round_submission', 'server', rd.match_id, rd.id,
      jsonb_build_object('expired_at', rd.expires_at, 'late_by_seconds',
                         round(extract(epoch from (now() - rd.expires_at))))
    );
    return jsonb_build_object('error', 'round_expired');

  else
    v_outcome := p_outcomes ->> (p_player_move || ':' || rd.opponent_choice);
    if v_outcome is null then return jsonb_build_object('error', 'bad_request'); end if;

    update public.rounds
       set state = 'resolved', player_choice = p_player_move,
           outcome = v_outcome, resolved_at = now()
     where id = rd.id and state = 'open';
    get diagnostics v_claimed = row_count;

    if v_claimed = 0 then
      select * into rd from public.rounds where id = p_round_id;
      if rd.player_choice is distinct from p_player_move then
        return jsonb_build_object('error', 'already_submitted');
      end if;
      v_outcome := rd.outcome;
    end if;
  end if;

  select count(*) filter (where outcome = 'win'),
         count(*) filter (where outcome = 'lose')
    into v_player, v_opponent
    from public.rounds
   where match_id = rd.match_id and state = 'resolved';

  v_needed   := (p_wins_needed ->> m.format)::int;
  v_complete := v_player >= v_needed or v_opponent >= v_needed;
  v_result := case when v_complete then (case when v_player >= v_needed then 'win' else 'lose' end) end;

  update public.matches
     set player_score   = v_player,
         opponent_score = v_opponent,
         status         = case when v_complete then 'complete' else 'in_progress' end,
         result         = v_result,
         finalized_at   = case when v_complete then now() end
   where id = rd.match_id;

  return jsonb_build_object(
    'round_number',    rd.round_number,
    'commitment',      rd.commitment,
    'opponent_choice', rd.opponent_choice,
    'nonce',           rd.nonce,
    'outcome',         v_outcome,
    'score',           jsonb_build_object('player', v_player, 'opponent', v_opponent),
    'match_complete',  v_complete,
    'match_result',    v_result
  );
end $$;

revoke all on function public.resolve_round(bigint, uuid, text, jsonb, jsonb)
  from public, anon, authenticated;

-- ================================================= client-reported integrity

/**
 * A client saying "the server contradicted itself".
 *
 * Recorded as source='client' and never as fact. It cannot be verified here —
 * the caller controls the payload — but it is the only channel by which the
 * failure the player actually saw reaches us, and a burst of these from
 * unrelated accounts is a stronger signal than anything we could detect alone.
 * Rate-limited so it cannot become a way to flood the table.
 */
create or replace function public.report_integrity(
  p_user_id uuid,
  p_kind    text,
  p_detail  jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind not in ('commitment_mismatch', 'outcome_disagreement', 'reveal_before_move') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if not public.take_rate_token(p_user_id, 'report_integrity') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  perform public.log_integrity_event(
    p_user_id, p_kind, 'client',
    nullif(p_detail ->> 'match_id', '')::uuid,
    nullif(p_detail ->> 'round_id', '')::bigint,
    -- Bounded: a client-supplied blob goes in the record, so cap what it can
    -- write rather than storing whatever it sends.
    jsonb_build_object('reported', left(p_detail::text, 2000))
  );
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.report_integrity(uuid, text, jsonb) from public, anon, authenticated;
