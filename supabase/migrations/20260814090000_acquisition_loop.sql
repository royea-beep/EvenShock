-- The acquisition loop: a reason to return, and the instruments to see whether
-- any of it works.
--
-- Everything here exists to close one gap. The predominance test needs roughly
-- 250-300 human-vs-human matches across 30+ distinct players per side; today
-- there is exactly one non-harness account and it is the treasury. See
-- docs/predominance-test.md. So the measurement of the gap is part of this
-- change, not a follow-up: a growth feature with no counter attached is a
-- feature you cannot tell is failing.
--
-- NOTHING HERE TOUCHES THE MONEY PATH. No payment function is modified, no
-- USDC, no stake. The one thing that moves is chips, minted through
-- `credit_ledger` exactly as match rewards are, so `minted = players + house`
-- is maintained by the same code that already maintains it.

-- =============================================================== the streak
--
-- ANTI-FARMING IS THE WHOLE DESIGN, and it is the same discipline as the match
-- rewards: those pay per resolved round with no completion bonus, so no format
-- is worth farming. The equivalent property here is that the streak rewards
-- RETURNING, never PLAYING MORE:
--
--   * At most one award per UTC day, enforced by `last_award_day` and again by
--     the ledger idem_key `streak:<user>:<date>`. Playing fifty matches today
--     pays exactly what playing one pays.
--   * The amount depends only on consecutive days, never on volume, format,
--     result, or opponent. There is no way to make today's bonus larger.
--   * Capped at STREAK_CAP days, so the tail is bounded and a long absence
--     costs a player very little to rebuild — a streak that becomes precious
--     is a streak that makes people feel punished for a day off.
--
-- WHY A TRIGGER rather than a call inside match finalization: the same reason
-- the Nemesis trophy became one. Matches finalize from more than one place
-- (solo `resolve_round`, and `mp_settle` for a friend match), and a fourth
-- call site is exactly the kind of thing that gets added without the award.
-- Firing on the row transition cannot be forgotten. It also means no Edge
-- Function redeploy: `play` is untouched by this migration.

create table if not exists public.player_streaks (
  user_id        uuid primary key references public.profiles (id) on delete cascade,
  current_days   int         not null default 0,
  best_days      int         not null default 0,
  last_award_day date,
  updated_at     timestamptz not null default now()
);
alter table public.player_streaks enable row level security;
revoke all on public.player_streaks from anon, authenticated;
-- Own row only: a player may see their own streak, nobody else's.
drop policy if exists player_streaks_own_row on public.player_streaks;
create policy player_streaks_own_row on public.player_streaks
  for select to authenticated using (user_id = auth.uid());
grant select on public.player_streaks to authenticated;

-- `daily_streak` has to be a permitted ledger reason or credit_ledger's insert
-- fails. Checked against the constraint rather than assumed — an unlisted
-- value would have been swallowed exactly as `geo_refused` was.
alter table public.ledger drop constraint if exists ledger_reason_check;
alter table public.ledger add constraint ledger_reason_check
  check (reason = any (array[
    'match_reward','theme_unlock','chip_purchase',
    'stake_post','stake_payout','stake_refund',
    'tournament_entry','tournament_prize','tournament_refund',
    'daily_streak'
  ]));

create or replace function public.touch_daily_streak(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  s          public.player_streaks;
  v_today    date := (now() at time zone 'utc')::date;
  v_bonus    int;
  v_cap      constant int := 7;
begin
  if p_user_id is null then return null; end if;

  insert into public.player_streaks (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select * into s from public.player_streaks where user_id = p_user_id for update;

  -- Already paid today. This is the anti-farm gate and it is checked before
  -- anything else happens.
  if s.last_award_day = v_today then
    return jsonb_build_object('awarded', false, 'reason', 'already_today',
                              'current_days', s.current_days);
  end if;

  if s.last_award_day = v_today - 1 then
    s.current_days := s.current_days + 1;
  else
    s.current_days := 1;   -- first ever, or the chain was broken
  end if;

  v_bonus := least(s.current_days, v_cap);

  update public.player_streaks
     set current_days   = s.current_days,
         best_days      = greatest(best_days, s.current_days),
         last_award_day = v_today,
         updated_at     = now()
   where user_id = p_user_id;

  -- Same mint path as every other chip in the system, so conservation is
  -- maintained by the function that already maintains it. The idem_key is a
  -- second, independent guarantee that a day pays once.
  perform public.credit_ledger(
    p_user_id, 'chips', v_bonus, 'daily_streak',
    'streak:' || p_user_id::text || ':' || v_today::text);

  return jsonb_build_object('awarded', true, 'chips', v_bonus,
                            'current_days', s.current_days, 'day', v_today);
end $$;
revoke all on function public.touch_daily_streak(uuid) from public, anon, authenticated;

create or replace function public.streak_on_match_complete()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.status = 'complete' and coalesce(old.status,'') <> 'complete' then
    perform public.touch_daily_streak(new.user_id);
  end if;
  return null;
end $$;

drop trigger if exists streak_after_solo_match on public.matches;
create trigger streak_after_solo_match
  after update on public.matches
  for each row execute function public.streak_on_match_complete();

create or replace function public.streak_on_table_finished()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.status = 'finished' and coalesce(old.status,'') <> 'finished' then
    perform public.touch_daily_streak(new.seat_a);
    perform public.touch_daily_streak(new.seat_b);
  end if;
  return null;
end $$;

drop trigger if exists streak_after_mp_table on public.mp_tables;
create trigger streak_after_mp_table
  after update on public.mp_tables
  for each row execute function public.streak_on_table_finished();

-- ========================================================= who is a real player
-- One definition, reused everywhere below, derived from the ladder's existing
-- rule rather than restated. `is_rateable_player` already excludes harness
-- accounts, the owner and the active treasury address — the three contamination
-- classes this project has already had to clean out once each.
create or replace function public.is_real_player(p_user_id uuid)
returns boolean
language sql stable security definer set search_path to '' as $$
  select public.is_rateable_player(p_user_id);
$$;
revoke all on function public.is_real_player(uuid) from public, anon, authenticated;

-- ============================================================ the funnel
--
-- DERIVED, NOT EMITTED, wherever possible. Every stage below except the first
-- is computed from rows the game already writes, so the funnel cannot drift
-- from reality by someone forgetting to fire an event — the same argument as
-- `matches.opponent` being the mode telemetry rather than a separate event.
--
-- THE HONEST GAP: stage 1 counts landings by people who went on to have an
-- identity. Someone who opens an invite link and closes the tab without ever
-- authenticating leaves no server-side trace, and giving `anon` an insert
-- grant to capture them would open a public write endpoint for a metric. That
-- trade is refused; the gap is stated instead.
create table if not exists public.acquisition_touch (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  invite_code text,
  referrer    text,
  landed_at   timestamptz not null default now()
);
alter table public.acquisition_touch enable row level security;
revoke all on public.acquisition_touch from anon, authenticated;

-- The one client-writable thing here, and it is deliberately narrow: a player
-- may record their OWN first-touch once, and never overwrite it. First touch
-- that can be rewritten is not first touch.
create or replace function public.record_acquisition_touch(
  p_user_id uuid, p_invite_code text, p_referrer text)
returns void
language plpgsql security definer set search_path to '' as $$
begin
  insert into public.acquisition_touch (user_id, invite_code, referrer)
  values (p_user_id,
          nullif(left(coalesce(p_invite_code, ''), 16), ''),
          nullif(left(coalesce(p_referrer, ''), 200), ''))
  on conflict (user_id) do nothing;
end $$;
revoke all on function public.record_acquisition_touch(uuid, text, text)
  from public, anon, authenticated;

create or replace function public.acquisition_funnel(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v jsonb;
begin
  if not exists (select 1 from public.profiles where id = p_user_id and is_owner) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  select jsonb_build_object(
    'stages', jsonb_build_object(
      'landed_via_invite', (select count(*) from public.acquisition_touch t
                             where t.invite_code is not null and public.is_real_player(t.user_id)),
      'identity_created',  (select count(*) from public.profiles p where public.is_real_player(p.id)),
      'wallet_connected',  (select count(*) from public.profiles p
                             where p.wallet_address is not null and public.is_real_player(p.id)),
      'started_a_match',   (select count(distinct m.user_id) from public.matches m
                             where public.is_real_player(m.user_id)),
      'completed_a_match', (select count(distinct m.user_id) from public.matches m
                             where m.status = 'complete' and public.is_real_player(m.user_id)),
      'played_a_human',    (select count(*) from (
                              select t.seat_a as u from public.mp_tables t where t.status='finished'
                              union
                              select t.seat_b from public.mp_tables t where t.status='finished') x
                             where public.is_real_player(x.u)),
      'returned_next_day', (select count(*) from (
                              select m.user_id, count(distinct (m.created_at at time zone 'utc')::date) d
                                from public.matches m where public.is_real_player(m.user_id)
                               group by m.user_id) y where y.d > 1)
    ),
    -- Retention, as days-active rather than a single flag: "came back once" and
    -- "comes back" are different products.
    'days_active_histogram', (
      select coalesce(jsonb_object_agg(d::text, n), '{}'::jsonb) from (
        select d, count(*) n from (
          select m.user_id, count(distinct (m.created_at at time zone 'utc')::date) d
            from public.matches m where public.is_real_player(m.user_id)
           group by m.user_id) z group by d) h),
    'streaks', (select coalesce(jsonb_build_object(
        'players_with_a_streak', count(*),
        'longest_current', max(current_days),
        'longest_ever', max(best_days)), '{}'::jsonb)
      from public.player_streaks s where public.is_real_player(s.user_id)),
    'note', 'landed_via_invite counts only visitors who later gained an identity; '
         || 'anonymous bounces are not recorded, by choice — see the migration.'
  ) into v;
  return v;
end $$;
revoke all on function public.acquisition_funnel(uuid) from public, anon, authenticated;

-- ================================================== the gap that matters
--
-- How far the predominance test still is from being runnable. Targets come
-- from docs/predominance-test.md §6: ~250 completed head-to-head matches, 30+
-- distinct players PER SIDE, and enough matches per player that the result
-- describes the game rather than a handful of people.
create or replace function public.predominance_gap(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_matches int; v_players int; v_scored int; v_per numeric;
  c_matches constant int := 250;
  c_players constant int := 60;   -- 30 per side
begin
  if not exists (select 1 from public.profiles where id = p_user_id and is_owner) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  -- A qualifying match: finished, and BOTH seats a real player. A table with a
  -- harness account on one side counts for nothing here, which is the whole
  -- reason the harness flag exists.
  select count(*) into v_matches from public.mp_tables t
   where t.status = 'finished'
     and public.is_real_player(t.seat_a) and public.is_real_player(t.seat_b);

  select count(*) into v_players from (
    select t.seat_a u from public.mp_tables t
      where t.status='finished' and public.is_real_player(t.seat_a) and public.is_real_player(t.seat_b)
    union
    select t.seat_b from public.mp_tables t
      where t.status='finished' and public.is_real_player(t.seat_a) and public.is_real_player(t.seat_b)) x;

  -- Players whose predictability score is above the confidence floor, i.e. who
  -- could actually be CLASSIFIED skilled or unskilled before being paired.
  -- Without these the test is circular even with enough matches.
  select count(*) into v_scored from public.player_skill_metrics m
   where m.confidence <> 'calibrating' and public.is_real_player(m.user_id);

  v_per := case when v_players > 0 then round(v_matches::numeric / v_players, 2) end;

  return jsonb_build_object(
    'human_matches',      jsonb_build_object('have', v_matches, 'need', c_matches,
                            'remaining', greatest(0, c_matches - v_matches),
                            'pct', round(100.0 * v_matches / c_matches, 1)),
    'distinct_players',   jsonb_build_object('have', v_players, 'need', c_players,
                            'remaining', greatest(0, c_players - v_players)),
    'classifiable_players', jsonb_build_object('have', v_scored,
                            'note', 'above the confidence floor, so they can be classified BEFORE pairing'),
    'matches_per_player', v_per,
    'runnable',           (v_matches >= c_matches and v_players >= c_players and v_scored >= c_players),
    'targets_from',       'docs/predominance-test.md section 6'
  );
end $$;
revoke all on function public.predominance_gap(uuid) from public, anon, authenticated;
