-- Skill layer, parts 2 and 3 of the EVENSHOCK-SKILL-LAYER brief: persisting
-- ratings, and the season ladder built on them.
--
-- ONLY HUMAN-VERSUS-HUMAN RESULTS ARE RATED. The reasoning is in the glicko2
-- migration header and is not repeated here, but the one-line version is that
-- the solo opponent is uniform random, so a solo result carries no information
-- about skill and rating on it would manufacture confidence in noise. The
-- entry point below therefore takes an `mp_tables` id and there is deliberately
-- no sibling that takes a `matches` id.
--
-- WHY THE LADDER IS A DEFINER FUNCTION AND NOT A VIEW. The brief asks for a
-- view. It cannot be one: `player_ratings` and `profiles` carry own-row RLS, so
-- a plain view shows each caller exactly themselves, which is a leaderboard of
-- one. This project already met and solved that — see the
-- `leaderboard_as_definer_function` migration — and the same answer applies
-- here. Shape and column list follow the brief; the mechanism follows the
-- database.

-- Rating a result twice is not a glitch, it is permanent: rating_history is
-- append-only by trigger, so a double-count can never be edited out. Make it
-- impossible rather than unlikely.
create unique index if not exists rating_history_one_row_per_source
  on public.rating_history (user_id, source, source_id);

-- --------------------------------------------------------------- the pipeline
-- One settled human-versus-human table becomes one rating period for each seat.
--
-- Both updates read the opponent's PRE-update numbers, which is why both rows
-- are loaded into variables before either is written. Rating A first and then
-- feeding A's new rating into B's update would make the result depend on which
-- seat was processed first — a ladder that quietly disagrees with itself
-- depending on row order.
create or replace function public.rate_mp_table(p_table_id uuid)
returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  t         public.mp_tables;
  v_first   uuid;
  v_second  uuid;
  ra        public.player_ratings;
  rb        public.player_ratings;
  v_a       jsonb;
  v_b       jsonb;
  v_score_a numeric;
begin
  select * into t from public.mp_tables where id = p_table_id for update;
  if not found then
    return jsonb_build_object('rated', false, 'reason', 'not_found');
  end if;

  -- A void refunds the stakes and decides nothing. Rating it would invent a
  -- result the players never produced.
  if t.seat_b is null then
    return jsonb_build_object('rated', false, 'reason', 'no_opponent');
  end if;
  if t.result is null or t.settlement is distinct from 'decided' then
    return jsonb_build_object('rated', false, 'reason', 'no_decided_result');
  end if;

  -- The brief's "filter them everywhere". A harness account is not a player,
  -- and a table involving one is not evidence about the human on the other
  -- seat either — so the whole table is skipped, not just one side of it.
  if not (public.is_rateable_player(t.seat_a) and public.is_rateable_player(t.seat_b)) then
    return jsonb_build_object('rated', false, 'reason', 'unrateable_seat');
  end if;

  if exists (select 1 from public.rating_history rh
              where rh.source = 'mp_table' and rh.source_id = t.id) then
    return jsonb_build_object('rated', false, 'reason', 'already_rated');
  end if;

  insert into public.player_ratings (user_id) values (t.seat_a) on conflict (user_id) do nothing;
  insert into public.player_ratings (user_id) values (t.seat_b) on conflict (user_id) do nothing;

  -- Locked in uuid order, the same discipline mp_settle uses on balances: two
  -- tables settling concurrently between the same pair would otherwise be able
  -- to take these rows in opposite orders and deadlock.
  v_first  := least(t.seat_a, t.seat_b);
  v_second := greatest(t.seat_a, t.seat_b);
  perform 1 from public.player_ratings where user_id = v_first  for update;
  perform 1 from public.player_ratings where user_id = v_second for update;

  select * into ra from public.player_ratings where user_id = t.seat_a;
  select * into rb from public.player_ratings where user_id = t.seat_b;

  v_score_a := case when t.result = 'a' then 1 else 0 end;

  v_a := public.glicko2_update(ra.rating, ra.rating_deviation, ra.volatility,
           jsonb_build_array(jsonb_build_object(
             'rating', rb.rating, 'rd', rb.rating_deviation, 'score', v_score_a)));
  v_b := public.glicko2_update(rb.rating, rb.rating_deviation, rb.volatility,
           jsonb_build_array(jsonb_build_object(
             'rating', ra.rating, 'rd', ra.rating_deviation, 'score', 1 - v_score_a)));

  update public.player_ratings
     set rating           = (v_a ->> 'rating')::numeric,
         rating_deviation = (v_a ->> 'rd')::numeric,
         volatility       = (v_a ->> 'volatility')::numeric,
         rated_matches    = rated_matches + 1,
         last_played_at   = coalesce(t.finalized_at, now()),
         updated_at       = now()
   where user_id = t.seat_a;

  update public.player_ratings
     set rating           = (v_b ->> 'rating')::numeric,
         rating_deviation = (v_b ->> 'rd')::numeric,
         volatility       = (v_b ->> 'volatility')::numeric,
         rated_matches    = rated_matches + 1,
         last_played_at   = coalesce(t.finalized_at, now()),
         updated_at       = now()
   where user_id = t.seat_b;

  insert into public.rating_history (
    user_id, rated_at, source, source_id, opponent_user_id, outcome,
    rating_before, rating_after, rd_before, rd_after, volatility_after
  ) values
    (t.seat_a, coalesce(t.finalized_at, now()), 'mp_table', t.id, t.seat_b, v_score_a,
     ra.rating, (v_a ->> 'rating')::numeric, ra.rating_deviation, (v_a ->> 'rd')::numeric,
     (v_a ->> 'volatility')::numeric),
    (t.seat_b, coalesce(t.finalized_at, now()), 'mp_table', t.id, t.seat_a, 1 - v_score_a,
     rb.rating, (v_b ->> 'rating')::numeric, rb.rating_deviation, (v_b ->> 'rd')::numeric,
     (v_b ->> 'volatility')::numeric);

  -- Their throw sequences just grew, so the skill scores are stale.
  perform public.refresh_player_skill_metrics(t.seat_a);
  perform public.refresh_player_skill_metrics(t.seat_b);

  return jsonb_build_object(
    'rated', true, 'table_id', t.id,
    'seat_a', jsonb_build_object('user_id', t.seat_a, 'before', ra.rating, 'after', v_a -> 'rating'),
    'seat_b', jsonb_build_object('user_id', t.seat_b, 'before', rb.rating, 'after', v_b -> 'rating')
  );
end $$;
revoke all on function public.rate_mp_table(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- the season
-- One active season at a time is already enforced structurally by the partial
-- unique index in the tables migration; this just makes opening one an
-- operation rather than a hand-written INSERT.
create or replace function public.open_season(
  p_name text, p_starts_at timestamptz, p_ends_at timestamptz
) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_id int;
begin
  update public.seasons set status = 'closed' where status = 'active' and ends_at <= now();
  insert into public.seasons (name, starts_at, ends_at, status)
  values (p_name, p_starts_at, p_ends_at, 'active')
  returning id into v_id;
  return jsonb_build_object('season_id', v_id, 'name', p_name);
exception
  when unique_violation then
    return jsonb_build_object('error', 'a season is already active');
end $$;
revoke all on function public.open_season(text, timestamptz, timestamptz) from public, anon, authenticated;

-- A first season so the ladder has somewhere to put results the moment human
-- play starts. Guarded, so re-running the migration cannot open a second one.
insert into public.seasons (name, starts_at, ends_at, status)
select 'Season 1', now(), now() + interval '90 days', 'active'
 where not exists (select 1 from public.seasons);

-- ------------------------------------------------------------- the leaderboard
-- Two different gates on two different numbers, which is the point:
--
--   p_min_rated  gates the LADDER. Rating is about who beat whom, so it counts
--                rated human-versus-human matches inside the season and
--                nothing else. Default 5, matching the existing leaderboard.
--
--   confidence   gates the SKILL COLUMNS, and comes from total rounds thrown
--                including solo. It is returned rather than filtered on,
--                because "calibrating" is a thing to render, not a reason to
--                hide someone whose ranking is perfectly well established.
--
-- Ordering is rating first, then the tighter rating deviation: between two
-- equal ratings the one we are more certain of ranks higher. Ties after that
-- break on the older account, so the order is total and stable.
create or replace function public.season_leaderboard(
  p_limit int default 100,
  p_min_rated int default 5
) returns table (
  rank bigint,
  user_id uuid,
  display_name text,
  rating numeric,
  rating_deviation numeric,
  matches_played bigint,
  win_rate numeric,
  predictability_score numeric,
  read_score numeric,
  confidence text
)
language sql stable security definer set search_path to '' as $$
  with s as (
    select * from public.seasons where status = 'active' order by starts_at desc limit 1
  ),
  season_play as (
    select rh.user_id,
           count(*)                              as played,
           count(*) filter (where rh.outcome = 1) as wins
      from public.rating_history rh
      join s on rh.rated_at >= s.starts_at and rh.rated_at < s.ends_at
     where rh.source = 'mp_table'
     group by rh.user_id
  )
  select row_number() over (
           order by pr.rating desc, pr.rating_deviation asc, p.created_at asc
         ) as rank,
         p.id,
         coalesce(nullif(p.display_name, ''),
                  left(p.wallet_address, 4) || '…' || right(p.wallet_address, 4)),
         round(pr.rating, 1),
         round(pr.rating_deviation, 1),
         sp.played,
         round(100.0 * sp.wins / nullif(sp.played, 0), 1),
         round(psm.predictability_score, 3),
         round(psm.read_score, 3),
         coalesce(psm.confidence, 'calibrating')
    from season_play sp
    join public.player_ratings pr on pr.user_id = sp.user_id
    join public.profiles p        on p.id = sp.user_id
    left join public.player_skill_metrics psm on psm.user_id = sp.user_id
   where public.is_rateable_player(sp.user_id)
     and sp.played >= greatest(1, coalesce(p_min_rated, 5))
   order by rank
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;
comment on function public.season_leaderboard(int, int) is
  'The active season ladder. Harness and owner accounts excluded via '
  'is_rateable_player; solo results are not rated and therefore never appear.';
grant execute on function public.season_leaderboard(int, int) to authenticated;
