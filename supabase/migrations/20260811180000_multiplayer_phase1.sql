-- Multiplayer, Phase 1: free tables, invite code only.
--
-- Two humans, one referee. The server no longer draws a move — it holds both
-- players' moves and refuses to reveal either until both are committed.
--
-- Design: docs/multiplayer-design.md. The decisions that shaped this file:
--
--   TWO SEAT COLUMNS, NOT A ROSTER TABLE. caps-poker uses game_rooms +
--   room_players + a denormalised current_players, and its own migrations
--   record what that cost: seat_index = current_players collided after a
--   leave, and a DELETE that bypassed the decrement left rooms that "read FULL
--   with an empty seat: un-joinable and un-startable". With exactly two seats,
--   `seat_a` and `seat_b` make both bugs unreachable rather than fixed —
--   there is no counter to desync and no index to collide. Claiming a seat is
--   one conditional UPDATE.
--
--   TIMINGS ARE ROWS, NOT CONSTANTS. Timeout behaviour that can only be tested
--   by waiting twenty seconds does not get tested, and timeouts are where
--   multiplayer rots. The harness sets these to milliseconds.
--
--   THE SERVER HOLDS BOTH (move, nonce) PAIRS. Reversed from the first design
--   draft, which wanted client-held nonces to keep the server blind. A
--   client-held nonce lives in sessionStorage, which throws in private
--   browsing — already the cause of one production bug here — and tying a
--   staked round to it turns a tab crash into a forfeited stake. The server is
--   in the trust base instead, and `mp_receipts` is what makes that
--   inspectable rather than assumed.

-- =========================================================== timing config
create table public.mp_timing (
  key         text primary key,
  ms          integer not null check (ms > 0),
  description text not null
);

insert into public.mp_timing (key, ms, description) values
  ('table_ttl',       15 * 60_000, 'Open table with one seat, before it is closed'),
  ('invite_ttl',      30 * 60_000, 'Invite code lifetime'),
  ('commit_window',        20_000, 'From round open until both moves must be committed'),
  ('reveal_window',        90_000, 'From the second commitment until both reveals must land'),
  ('disconnect_grace',     60_000, 'Presence gap before a mid-match player forfeits'),
  ('match_idle',      10 * 60_000, 'Any non-terminal match with no activity is voided');

alter table public.mp_timing enable row level security;
revoke all on public.mp_timing from anon, authenticated;

create or replace function public.mp_ms(p_key text)
returns integer language sql stable security definer set search_path = ''
as $$ select ms from public.mp_timing where key = p_key $$;
revoke all on function public.mp_ms(text) from public, anon, authenticated;

-- ================================================================= tables
--
-- `seat_a` is the creator and is never null. `seat_b` null means one seat open.
create table public.mp_tables (
  id           uuid primary key default gen_random_uuid(),
  invite_code  text not null unique,
  format       text not null check (format in ('single', 'bo3', 'bo5')),
  -- Phase 1 is free tables only. The column exists so Phase 3 is an update
  -- rather than a migration of live rows, and the check keeps it honest until
  -- then: a non-zero stake cannot be created by anything shipping today.
  stake_chips  bigint not null default 0 check (stake_chips = 0),
  seat_a       uuid not null references auth.users (id) on delete cascade,
  seat_b       uuid references auth.users (id) on delete set null,
  status       text not null default 'open'
               check (status in ('open', 'playing', 'finished', 'abandoned')),
  -- The table IS the match. Deliberately NOT a row in `matches`: that table
  -- feeds the solo leaderboard and the XP curve, and a multiplayer result
  -- landing in it would count a human opponent as a bot win. Keeping the two
  -- histories separate also means Phase 1 awards nothing — no XP, no chips —
  -- which closes the obvious farm before it opens: two accounts playing each
  -- other cannot mint anything if nothing is minted.
  a_score      int not null default 0,
  b_score      int not null default 0,
  result       text check (result in ('a', 'b')),
  finalized_at timestamptz,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  closed_at    timestamptz,
  -- Both players must be distinct humans. Nothing in the join path can produce
  -- a self-match, and the constraint means nothing ever will.
  constraint mp_tables_distinct_seats check (seat_b is null or seat_b <> seat_a)
);

-- One open table per player: the entire anti-squat story, as a constraint.
create unique index mp_tables_one_open_per_creator
  on public.mp_tables (seat_a) where status = 'open';
create index mp_tables_open_idx on public.mp_tables (status) where status = 'open';
create index mp_tables_seats_idx on public.mp_tables (seat_a, seat_b);

comment on table public.mp_tables is
  'Two seats as columns, deliberately. With exactly two players there is no roster to desync and no seat index to collide — see the migration header.';

-- ================================================================= rounds
--
-- One row per round. Both moves and both nonces live here, in columns no
-- client has a SELECT grant on — the same shape as rounds.opponent_choice.
create table public.mp_rounds (
  id            bigint generated always as identity primary key,
  table_id      uuid not null references public.mp_tables (id) on delete cascade,
  round_number  int not null,

  a_move        text check (a_move in ('rock', 'paper', 'scissors')),
  a_nonce       text,
  a_commitment  text,
  a_committed_at timestamptz,
  a_revealed_at  timestamptz,

  b_move        text check (b_move in ('rock', 'paper', 'scissors')),
  b_nonce       text,
  b_commitment  text,
  b_committed_at timestamptz,
  b_revealed_at  timestamptz,

  -- Set when the SECOND commitment lands. Everything downstream keys off this:
  -- it starts the reveal window and it is the only signal a client gets that
  -- the round may begin its wind-up.
  both_committed_at timestamptz,

  state    text not null default 'open'
           check (state in ('open', 'committed', 'resolved', 'void')),
  outcome  text check (outcome in ('a', 'b', 'tie')),
  -- Why the round ended the way it did. 'played' is a real result; the others
  -- are the timeout paths, and the client needs to tell them apart to say
  -- something true to whoever lost.
  resolution text check (resolution in
    ('played', 'commit_timeout', 'reveal_timeout', 'void_no_commits', 'void_no_reveals')),

  created_at  timestamptz not null default now(),
  resolved_at timestamptz,

  unique (table_id, round_number)
);

create index mp_rounds_table_idx on public.mp_rounds (table_id, round_number);
create index mp_rounds_open_idx on public.mp_rounds (state)
  where state in ('open', 'committed');

-- ============================================================== receipts
--
-- The audit trail that keeps "the server is in the trust base" inspectable.
--
-- A receipt is a signature over (round, player, commitment), issued at commit
-- time — BEFORE either move is revealed. Later, verify_match_integrity
-- re-derives the digest from the stored (move, nonce) and compares it to the
-- commitment this receipt was signed over. A server that revealed something
-- other than what it committed would have to produce a pair that hashes to a
-- digest it already signed, which it cannot do.
--
-- This proves the server did not CHANGE ITS MIND. It cannot prove the server
-- did not peek — nothing can, once the server holds the pair — and saying so
-- plainly is part of the deal.
create table public.mp_receipts (
  round_id    bigint not null references public.mp_rounds (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  commitment  text not null,
  signature   text not null,
  key_id      text not null,
  issued_at   timestamptz not null default now(),
  primary key (round_id, user_id)
);

alter table public.mp_tables   enable row level security;
alter table public.mp_rounds   enable row level security;
alter table public.mp_receipts enable row level security;

revoke all on public.mp_tables   from anon, authenticated;
revoke all on public.mp_rounds   from anon, authenticated;
revoke all on public.mp_receipts from anon, authenticated;

-- A player may READ the tables they are seated at, and write none of it.
create policy mp_tables_select_seated on public.mp_tables
  for select to authenticated
  using ((select auth.uid()) in (seat_a, seat_b));
grant select on public.mp_tables to authenticated;

-- Receipts are readable by their owner: the player needs the signature to
-- check the reveal against, which is the whole point of issuing it.
create policy mp_receipts_select_own on public.mp_receipts
  for select to authenticated using ((select auth.uid()) = user_id);
grant select on public.mp_receipts to authenticated;

-- mp_rounds is NEVER client-readable. It holds both moves and both nonces, and
-- there is no column subset a player may see before the server decides they
-- may — RLS cannot scope columns, so the grant is simply absent. Reveals go
-- out through the Edge Function, which decides what to include.

-- ========================================================= invite codes
--
-- 8 characters from a 32-character alphabet with 0/O/1/I/l removed: 32^8, or
-- about 1.1e12. The rate limit on redemption is what actually bounds guessing;
-- the length is comfort.
create or replace function public.mp_new_invite_code()
returns text language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
  v_try int := 0;
begin
  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (
      select 1 from public.mp_tables where invite_code = v_code and status = 'open'
    );
    v_try := v_try + 1;
    if v_try > 20 then raise exception 'could not allocate an invite code'; end if;
  end loop;
  return v_code;
end $$;
revoke all on function public.mp_new_invite_code() from public, anon, authenticated;


-- ====================================================== resolving a round
--
-- ONE place writes an outcome. The played path and all three timeout paths go
-- through it, so scoring, match completion and the reveal-latency sample can
-- never drift between them — the bug where a timeout scores differently from a
-- played round is exactly the kind that hides until someone loses a match to it.
--
-- `p_outcomes` is the nine-pair table generated from src/utils/rules.ts and
-- passed in by the caller, the same discipline as resolve_round: this function
-- looks the answer up and never knows what beats what.
create or replace function public.mp_resolve(
  p_round_id    bigint,
  p_outcome     text,        -- 'a' | 'b' | 'tie', or null to let it be computed
  p_resolution  text,
  p_wins_needed jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r public.mp_rounds;
  t public.mp_tables;
  v_a int; v_b int; v_needed int; v_complete boolean; v_winner uuid;
begin
  select * into r from public.mp_rounds where id = p_round_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if r.state in ('resolved', 'void') then
    return jsonb_build_object('ok', true, 'already', r.state);
  end if;

  select * into t from public.mp_tables where id = r.table_id for update;

  update public.mp_rounds
     set state = case when p_resolution in ('void_no_commits', 'void_no_reveals')
                      then 'void' else 'resolved' end,
         outcome = p_outcome,
         resolution = p_resolution,
         resolved_at = now()
   where id = p_round_id;

  -- Reveal latency is sampled here; the table it goes to and the reason it is
  -- NOT integrity_events are in the very next migration, which the Phase 0
  -- test forced within minutes of this one being applied.

  -- Score recomputed from resolved rounds rather than incremented, so a retry
  -- or a double sweep cannot inflate it.
  select count(*) filter (where outcome = 'a'), count(*) filter (where outcome = 'b')
    into v_a, v_b
    from public.mp_rounds where table_id = r.table_id and state = 'resolved';

  v_needed := coalesce((p_wins_needed ->> t.format)::int, 1);
  v_complete := v_a >= v_needed or v_b >= v_needed;
  if v_complete then
    v_winner := case when v_a >= v_needed then t.seat_a else t.seat_b end;
  end if;

  update public.mp_tables
     set a_score = v_a, b_score = v_b,
         status = case when v_complete then 'finished' else status end,
         result = case when v_complete then (case when v_a >= v_needed then 'a' else 'b' end) end,
         finalized_at = case when v_complete then now() else finalized_at end,
         closed_at = case when v_complete then now() else closed_at end
   where id = t.id;

  return jsonb_build_object(
    'ok', true, 'outcome', p_outcome, 'resolution', p_resolution,
    'score', jsonb_build_object('a', v_a, 'b', v_b),
    'match_complete', v_complete, 'winner', v_winner
  );
end $$;
revoke all on function public.mp_resolve(bigint, text, text, jsonb) from public, anon, authenticated;

-- ============================================================== sweeping
--
-- Opportunistic, called by every action. A cron backstop arrives in Phase 3
-- alongside escrow — position changed after reviewing caps-poker, whose
-- client-driven finish_table leaked rooms stuck in 'playing' until a
-- self-healing sweep was added. An opportunistic sweep only runs when someone
-- comes back, and the failure mode of an abandoned match is that nobody does.
-- With no chips at risk in Phase 1, a late sweep costs a stale row and nothing
-- else; with a pot on the table it would cost locked chips, which is why the
-- backstop is not optional then.
create or replace function public.mp_sweep(p_wins_needed jsonb default '{}'::jsonb)
returns int language plpgsql security definer set search_path = ''
as $$
declare v_n int := 0; v_c int; v_row record;
begin
  update public.mp_tables set status = 'abandoned', closed_at = now()
   where status = 'open' and expires_at < now();
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- Commit window closed. One committer beats none; neither is a void replay.
  for v_row in
    select id,
           case when a_committed_at is not null and b_committed_at is null then 'a'
                when b_committed_at is not null and a_committed_at is null then 'b'
                else null end as who,
           (a_committed_at is null and b_committed_at is null) as silent
      from public.mp_rounds
     where state = 'open'
       and created_at < now() - make_interval(secs => public.mp_ms('commit_window') / 1000.0)
  loop
    perform public.mp_resolve(
      v_row.id, v_row.who,
      case when v_row.silent then 'void_no_commits' else 'commit_timeout' end,
      p_wins_needed);
    v_n := v_n + 1;
  end loop;

  -- Reveal window closed. Whoever revealed takes the round outright — this is
  -- what makes non-reveal strictly dominated rather than merely discouraged.
  for v_row in
    select id,
           case when a_revealed_at is not null and b_revealed_at is null then 'a'
                when b_revealed_at is not null and a_revealed_at is null then 'b'
                else null end as who,
           (a_revealed_at is null and b_revealed_at is null) as silent
      from public.mp_rounds
     where state = 'committed'
       and both_committed_at < now() - make_interval(secs => public.mp_ms('reveal_window') / 1000.0)
  loop
    perform public.mp_resolve(
      v_row.id, v_row.who,
      case when v_row.silent then 'void_no_reveals' else 'reveal_timeout' end,
      p_wins_needed);
    v_n := v_n + 1;
  end loop;

  return v_n;
end $$;
revoke all on function public.mp_sweep(jsonb) from public, anon, authenticated;

-- ====================================================== integrity audit
--
-- Re-derives every commitment in a match from the stored (move, nonce) and
-- compares it to the digest the receipt was signed over. The signature itself
-- is checked by the Edge Function, which holds the public key; this function
-- proves the half that lives in SQL — that the pair on record still hashes to
-- the digest we published before revealing anything.
--
-- Callable by either seated player. An audit only the operator can run is not
-- an audit, it is a promise.
create or replace function public.verify_match_integrity(p_table_id uuid)
returns table (round_number int, player text, commitment text, signature text,
               key_id text, digest_input text, matches boolean)
language sql stable security definer set search_path = ''
as $$
  select r.round_number, x.player, x.commitment, rc.signature, rc.key_id,
         r.id::text || ':' || x.user_id::text || ':' || x.move || ':' || x.nonce as digest_input,
         (rc.commitment = x.commitment) as matches
    from public.mp_rounds r
    join public.mp_tables t on t.id = r.table_id
    cross join lateral (values
      ('a', t.seat_a, r.a_move, r.a_nonce, r.a_commitment),
      ('b', t.seat_b, r.b_move, r.b_nonce, r.b_commitment)
    ) as x(player, user_id, move, nonce, commitment)
    left join public.mp_receipts rc on rc.round_id = r.id and rc.user_id = x.user_id
   where r.table_id = p_table_id
     and x.move is not null
     and (t.seat_a = (select auth.uid()) or t.seat_b = (select auth.uid()))
   order by r.round_number, x.player;
$$;
grant execute on function public.verify_match_integrity(uuid) to authenticated;

-- Rate limits for the new actions.
create or replace function public.take_rate_token(p_user_id uuid, p_action text)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  v_per_minute int; v_per_hour int; v_minute_hits int; v_hour_hits int;
begin
  case p_action
    when 'open_match'       then v_per_minute :=  30; v_per_hour :=  200;
    when 'open_round'       then v_per_minute :=  60; v_per_hour :=  600;
    when 'submit'           then v_per_minute :=  60; v_per_hour :=  600;
    when 'report_integrity' then v_per_minute :=  10; v_per_hour :=   60;
    when 'economy_state'    then v_per_minute := 120; v_per_hour := 1200;
    when 'buy'              then v_per_minute :=  20; v_per_hour :=  200;
    when 'health'           then v_per_minute :=  20; v_per_hour :=  200;
    when 'payment_intent'   then v_per_minute :=  10; v_per_hour :=   60;
    when 'confirm_payment'  then v_per_minute :=  60; v_per_hour :=  600;
    -- Multiplayer. mp_join is the one that bounds invite-code guessing, so it
    -- is the tightest of the three.
    when 'mp_create'        then v_per_minute :=  10; v_per_hour :=   60;
    when 'mp_join'          then v_per_minute :=  10; v_per_hour :=   60;
    when 'mp_state'         then v_per_minute := 240; v_per_hour := 3000;
    when 'mp_move'          then v_per_minute :=  60; v_per_hour :=  600;
    else                         v_per_minute :=  60; v_per_hour :=  600;
  end case;

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

  delete from public.rate_buckets
   where user_id = p_user_id and window_start < now() - interval '3 hours';

  if v_minute_hits > v_per_minute or v_hour_hits > v_per_hour then
    perform public.log_integrity_event(
      p_user_id, 'rate_limited', 'server', null, null,
      jsonb_build_object('action', p_action,
        'minute_hits', v_minute_hits, 'minute_limit', v_per_minute,
        'hour_hits', v_hour_hits, 'hour_limit', v_per_hour));
    return false;
  end if;
  return true;
end $$;
revoke all on function public.take_rate_token(uuid, text) from public, anon, authenticated;

-- ================================================================= actions
--
-- Every one takes the caller's id as an argument BUT is only reachable through
-- the Edge Function, which derives that id from a verified JWT signature and
-- never from the request body. caps-poker's join_table took the identity as a
-- client parameter and its own migration calls the result "SPOOFABLE — a
-- caller can claim a seat as any uuid it likes"; the reason ours is safe is
-- that no client holds EXECUTE on any of these.

create or replace function public.mp_create_table(p_user_id uuid, p_format text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_code text; v_row public.mp_tables;
begin
  if not public.take_rate_token(p_user_id, 'mp_create') then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if p_format not in ('single', 'bo3', 'bo5') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  perform public.mp_sweep();

  -- One open table per player. Replacing rather than refusing: a player who
  -- lost the code to their own table should not be locked out of making
  -- another, and the partial unique index would otherwise make that a dead end.
  update public.mp_tables set status = 'abandoned', closed_at = now()
   where seat_a = p_user_id and status = 'open';

  v_code := public.mp_new_invite_code();
  insert into public.mp_tables (invite_code, format, seat_a, expires_at)
  values (v_code, p_format, p_user_id,
          now() + make_interval(secs => public.mp_ms('table_ttl') / 1000.0))
  returning * into v_row;

  return jsonb_build_object('ok', true, 'table_id', v_row.id, 'invite_code', v_row.invite_code,
                            'format', v_row.format, 'status', v_row.status,
                            'expires_at', v_row.expires_at, 'seat', 'a');
end $$;
revoke all on function public.mp_create_table(uuid, text) from public, anon, authenticated;

-- Claiming the second seat. One conditional UPDATE does the whole job: the
-- `seat_b is null` predicate is the concurrency control, so two players racing
-- for the last seat cannot both win and there is no counter to reconcile.
create or replace function public.mp_join_table(p_user_id uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_row public.mp_tables;
begin
  if not public.take_rate_token(p_user_id, 'mp_join') then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  perform public.mp_sweep();

  -- Already seated here? Idempotent, so a reconnect or a double tap rejoins
  -- rather than erroring.
  select * into v_row from public.mp_tables
   where invite_code = upper(p_code) and p_user_id in (seat_a, seat_b)
     and status in ('open', 'playing');
  if found then
    return jsonb_build_object('ok', true, 'table_id', v_row.id, 'status', v_row.status,
      'format', v_row.format, 'already_seated', true,
      'seat', case when v_row.seat_a = p_user_id then 'a' else 'b' end);
  end if;

  update public.mp_tables
     set seat_b = p_user_id, status = 'playing'
   where invite_code = upper(p_code)
     and status = 'open'
     and seat_b is null
     and seat_a <> p_user_id          -- no self-matches, belt as well as the CHECK
     and expires_at > now()
  returning * into v_row;

  if not found then
    -- Deliberately one message for "no such code", "already full", "expired"
    -- and "that's your own table". An attacker guessing codes learns nothing
    -- about which of those it hit.
    return jsonb_build_object('error', 'table_unavailable');
  end if;

  return jsonb_build_object('ok', true, 'table_id', v_row.id, 'status', v_row.status,
                            'format', v_row.format, 'seat', 'b');
end $$;
revoke all on function public.mp_join_table(uuid, text) from public, anon, authenticated;

-- Opens the next round. Idempotent: whoever asks first creates it, the other
-- gets the same row back, so both clients can call this without coordinating.
create or replace function public.mp_open_round(p_user_id uuid, p_table_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare t public.mp_tables; r public.mp_rounds; v_next int;
begin
  select * into t from public.mp_tables where id = p_table_id for update;
  if not found or p_user_id not in (t.seat_a, coalesce(t.seat_b, t.seat_a)) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if t.status <> 'playing' then return jsonb_build_object('error', 'table_closed'); end if;

  select * into r from public.mp_rounds
   where table_id = t.id and state in ('open', 'committed')
   order by round_number desc limit 1;
  if found then
    return jsonb_build_object('ok', true, 'round_id', r.id, 'round_number', r.round_number,
                              'state', r.state, 'created', false);
  end if;

  select coalesce(max(round_number), 0) + 1 into v_next
    from public.mp_rounds where table_id = t.id;
  insert into public.mp_rounds (table_id, round_number) values (t.id, v_next)
  returning * into r;

  return jsonb_build_object('ok', true, 'round_id', r.id, 'round_number', r.round_number,
                            'state', r.state, 'created', true);
end $$;
revoke all on function public.mp_open_round(uuid, uuid) from public, anon, authenticated;

-- Records a commitment. The move, nonce and digest are all computed by the
-- Edge Function; this stores them in the caller's own slot and never returns
-- them. `both_committed_at` is set by whichever commitment lands second, and
-- that timestamp is the ONLY thing either client is told about the other's
-- progress until both have revealed.
create or replace function public.mp_commit(
  p_user_id uuid, p_round_id bigint, p_move text, p_nonce text, p_commitment text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r public.mp_rounds; t public.mp_tables; v_seat text; v_both boolean;
begin
  if not public.take_rate_token(p_user_id, 'mp_move') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  select * into r from public.mp_rounds where id = p_round_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  select * into t from public.mp_tables where id = r.table_id;
  v_seat := case when t.seat_a = p_user_id then 'a'
                 when t.seat_b = p_user_id then 'b' end;
  if v_seat is null then return jsonb_build_object('error', 'not_found'); end if;
  if r.state <> 'open' then return jsonb_build_object('error', 'round_closed'); end if;

  if r.created_at < now() - make_interval(secs => public.mp_ms('commit_window') / 1000.0) then
    return jsonb_build_object('error', 'round_expired');
  end if;

  if (v_seat = 'a' and r.a_committed_at is not null)
     or (v_seat = 'b' and r.b_committed_at is not null) then
    return jsonb_build_object('error', 'already_committed');
  end if;

  if v_seat = 'a' then
    update public.mp_rounds set a_move = p_move, a_nonce = p_nonce,
           a_commitment = p_commitment, a_committed_at = now()
     where id = r.id returning * into r;
  else
    update public.mp_rounds set b_move = p_move, b_nonce = p_nonce,
           b_commitment = p_commitment, b_committed_at = now()
     where id = r.id returning * into r;
  end if;

  v_both := r.a_committed_at is not null and r.b_committed_at is not null;
  if v_both and r.both_committed_at is null then
    update public.mp_rounds set both_committed_at = now(), state = 'committed'
     where id = r.id returning * into r;
  end if;

  return jsonb_build_object('ok', true, 'seat', v_seat, 'commitment', p_commitment,
                            'both_committed', v_both, 'round_id', r.id);
end $$;
revoke all on function public.mp_commit(uuid, bigint, text, text, text) from public, anon, authenticated;

-- Marks the caller revealed, and resolves once both have.
--
-- THE RULE THAT MAKES NON-REVEAL STRICTLY DOMINATED lives here by omission:
-- this function returns NOTHING about the opponent until both reveals are in.
-- A player deciding whether to reveal therefore has no information, so
-- revealing (win, lose or tie) always beats not revealing (a certain loss on
-- the sweep). Do not "optimise" this by returning the opponent's move as soon
-- as it exists — that single change hands the second revealer a free option
-- and turns every table adversarial.
create or replace function public.mp_reveal(
  p_user_id uuid, p_round_id bigint, p_outcomes jsonb, p_wins_needed jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r public.mp_rounds; t public.mp_tables; v_seat text;
  v_outcome text; v_a_wins text; v_res jsonb;
begin
  if not public.take_rate_token(p_user_id, 'mp_move') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  select * into r from public.mp_rounds where id = p_round_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  select * into t from public.mp_tables where id = r.table_id;
  v_seat := case when t.seat_a = p_user_id then 'a'
                 when t.seat_b = p_user_id then 'b' end;
  if v_seat is null then return jsonb_build_object('error', 'not_found'); end if;

  if r.state = 'resolved' or r.state = 'void' then
    -- Already settled, possibly by the sweep. Return the settled truth rather
    -- than an error: a client that reveals a moment late deserves the result,
    -- and `resolution` tells it whether it forfeited.
    return jsonb_build_object('ok', true, 'settled', true, 'state', r.state,
      'outcome', r.outcome, 'resolution', r.resolution);
  end if;
  if r.state <> 'committed' then return jsonb_build_object('error', 'not_committed'); end if;

  if v_seat = 'a' and r.a_revealed_at is null then
    update public.mp_rounds set a_revealed_at = now() where id = r.id returning * into r;
  elsif v_seat = 'b' and r.b_revealed_at is null then
    update public.mp_rounds set b_revealed_at = now() where id = r.id returning * into r;
  end if;

  if r.a_revealed_at is null or r.b_revealed_at is null then
    -- Waiting on the other side. Nothing about their move crosses this line.
    return jsonb_build_object('ok', true, 'waiting_for_opponent', true);
  end if;

  -- Both in. The outcome table is generated from src/utils/rules.ts and passed
  -- in, so this looks the answer up and never knows what beats what.
  v_a_wins := p_outcomes ->> (r.a_move || ':' || r.b_move);
  v_outcome := case v_a_wins when 'win' then 'a' when 'lose' then 'b' else 'tie' end;
  v_res := public.mp_resolve(r.id, v_outcome, 'played', p_wins_needed);

  return jsonb_build_object('ok', true, 'settled', true, 'resolution', 'played',
    'outcome', v_outcome, 'a_move', r.a_move, 'b_move', r.b_move,
    'a_nonce', r.a_nonce, 'b_nonce', r.b_nonce,
    'a_commitment', r.a_commitment, 'b_commitment', r.b_commitment,
    'score', v_res -> 'score', 'match_complete', v_res -> 'match_complete');
end $$;
revoke all on function public.mp_reveal(uuid, bigint, jsonb, jsonb) from public, anon, authenticated;

-- What a client reads after a doorbell. Sweeps first, so a client that returns
-- to an abandoned table is told so rather than shown a table that no longer is.
create or replace function public.mp_state(p_user_id uuid, p_table_id uuid, p_wins_needed jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare t public.mp_tables; r public.mp_rounds; v_seat text;
begin
  if not public.take_rate_token(p_user_id, 'mp_state') then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  perform public.mp_sweep(p_wins_needed);

  select * into t from public.mp_tables where id = p_table_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  v_seat := case when t.seat_a = p_user_id then 'a'
                 when t.seat_b = p_user_id then 'b' end;
  if v_seat is null then return jsonb_build_object('error', 'not_found'); end if;

  select * into r from public.mp_rounds where table_id = t.id
   order by round_number desc limit 1;

  return jsonb_build_object(
    'ok', true, 'seat', v_seat, 'status', t.status, 'format', t.format,
    'invite_code', case when v_seat = 'a' then t.invite_code end,
    'opponent_seated', t.seat_b is not null,
    'score', jsonb_build_object('a', t.a_score, 'b', t.b_score),
    'result', t.result,
    'round', case when r.id is null then null else jsonb_build_object(
      'round_id', r.id, 'round_number', r.round_number, 'state', r.state,
      -- Only ever the caller's OWN commitment status, plus the symmetric
      -- both-committed flag. "Has my opponent moved?" is deliberately not
      -- answerable: it is asymmetric information and the leak discipline here
      -- has been to not ship asymmetries and argue about them later.
      'you_committed', case when v_seat = 'a' then r.a_committed_at is not null
                            else r.b_committed_at is not null end,
      'both_committed', r.both_committed_at is not null,
      'you_revealed', case when v_seat = 'a' then r.a_revealed_at is not null
                           else r.b_revealed_at is not null end,
      'outcome', r.outcome, 'resolution', r.resolution) end
  );
end $$;
revoke all on function public.mp_state(uuid, uuid, jsonb) from public, anon, authenticated;

-- Receipts are written by the Edge Function after it signs; separate from
-- mp_commit so the signing key never has to be reachable from SQL.
create or replace function public.mp_record_receipt(
  p_round_id bigint, p_user_id uuid, p_commitment text, p_signature text, p_key_id text
) returns void language sql security definer set search_path = ''
as $$
  insert into public.mp_receipts (round_id, user_id, commitment, signature, key_id)
  values (p_round_id, p_user_id, p_commitment, p_signature, p_key_id)
  on conflict (round_id, user_id) do nothing;
$$;
revoke all on function public.mp_record_receipt(bigint, uuid, text, text, text)
  from public, anon, authenticated;
