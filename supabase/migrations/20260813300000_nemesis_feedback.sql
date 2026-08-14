-- NEMESIS, part 4: what the player learns about themselves.
--
-- Nemesis without feedback is just a bot that wins more. The point is that the
-- player finds out WHY. Every number below is read back out of the state that
-- actually produced the throws — the model Nemesis selected, the context it
-- looked at, and the counts in it — so the tell is a fact about the player
-- rather than a generated tip that happens to sound personal.
--
-- THE BEFORE/AFTER IS COMPUTED, NOT STORED. "Your predictability fell from
-- 0.62 to 0.58" is the loop this whole mode exists to close, so it must be
-- true. It is derived by scoring the player's history twice — once excluding
-- this match's rounds, once including them — rather than by remembering an
-- older number that may have been produced by a different version of the
-- metric.

-- The trophy. Deliberately a measurement rather than a count: you cannot farm
-- it by playing more, only by becoming harder to read.
alter table public.player_skill_metrics
  add column if not exists lowest_predictability numeric,
  add column if not exists lowest_predictability_at timestamptz;

create or replace function public.nemesis_match_report(p_match_id uuid, p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  m            public.matches;
  v_rounds     int;
  v_read       int;
  v_blind      int;
  v_read_won   int;
  v_blind_won  int;
  v_model      text;
  v_context    text;
  v_ctx_rounds int;
  r            record;
  v_before     numeric;
  v_after      numeric;
  v_seen_before int;
  v_ramp_start numeric;
begin
  select * into m from public.matches where id = p_match_id and user_id = p_user_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if m.opponent is distinct from 'nemesis' then
    return jsonb_build_object('error', 'not_nemesis');
  end if;
  -- Never mid-match: the breakdown names which rounds were read, and knowing
  -- that before the match is over is a live advantage.
  if m.status <> 'complete' then
    return jsonb_build_object('error', 'match_in_progress');
  end if;

  select count(*),
         count(*) filter (where nr.exploited),
         count(*) filter (where not nr.exploited),
         count(*) filter (where nr.exploited and r2.outcome = 'win'),
         count(*) filter (where not nr.exploited and r2.outcome = 'win')
    into v_rounds, v_read, v_blind, v_read_won, v_blind_won
    from public.rounds r2
    left join public.nemesis_rounds nr on nr.round_id = r2.id
   where r2.match_id = p_match_id and r2.state = 'resolved';

  -- The lens Nemesis leaned on most this match, and the situation it watched.
  select nr.model, nr.context, count(*)
    into v_model, v_context, v_ctx_rounds
    from public.rounds r3
    join public.nemesis_rounds nr on nr.round_id = r3.id
   where r3.match_id = p_match_id and r3.state = 'resolved' and nr.exploited
   group by nr.model, nr.context
   order by count(*) desc, nr.model
   limit 1;

  -- The tell, in the player's own lifetime numbers rather than the decayed
  -- ones Nemesis plays on: "7 times out of 11" has to be countable by hand.
  if v_model is not null then
    select * into r
      from public.skill_context_stats(
        (select array_agg(move order by ord) from (
           select row_number() over (order by mm.created_at, rr.round_number) as ord,
                  rr.player_choice as move
             from public.rounds rr join public.matches mm on mm.id = rr.match_id
            where rr.user_id = p_user_id and rr.state = 'resolved'
              and rr.player_choice is not null) a),
        (select array_agg(pv order by ord) from (
           select row_number() over (order by mm.created_at, rr.round_number) as ord,
                  lag(rr.player_choice) over (partition by rr.match_id order by rr.round_number) as pv
             from public.rounds rr join public.matches mm on mm.id = rr.match_id
            where rr.user_id = p_user_id and rr.state = 'resolved'
              and rr.player_choice is not null) b),
        (select array_agg(po order by ord) from (
           select row_number() over (order by mm.created_at, rr.round_number) as ord,
                  lag(rr.outcome) over (partition by rr.match_id order by rr.round_number) as po
             from public.rounds rr join public.matches mm on mm.id = rr.match_id
            where rr.user_id = p_user_id and rr.state = 'resolved'
              and rr.player_choice is not null) c),
        null) s
     where s.model = v_model and s.context = v_context;
  end if;

  -- Predictability with and without this match. Same function, two windows.
  select public.skill_predictability(
           array_agg(move order by ord),
           array_agg(pv order by ord),
           array_agg(po order by ord))
    into v_after
    from (
      select row_number() over (order by mm.created_at, rr.round_number) as ord,
             rr.player_choice as move,
             lag(rr.player_choice) over (partition by rr.match_id order by rr.round_number) as pv,
             lag(rr.outcome)       over (partition by rr.match_id order by rr.round_number) as po
        from public.rounds rr join public.matches mm on mm.id = rr.match_id
       where rr.user_id = p_user_id and rr.state = 'resolved' and rr.player_choice is not null
    ) x;

  select public.skill_predictability(
           array_agg(move order by ord),
           array_agg(pv order by ord),
           array_agg(po order by ord))
    into v_before
    from (
      select row_number() over (order by mm.created_at, rr.round_number) as ord,
             rr.player_choice as move,
             lag(rr.player_choice) over (partition by rr.match_id order by rr.round_number) as pv,
             lag(rr.outcome)       over (partition by rr.match_id order by rr.round_number) as po
        from public.rounds rr join public.matches mm on mm.id = rr.match_id
       where rr.user_id = p_user_id and rr.state = 'resolved' and rr.player_choice is not null
         and rr.match_id <> p_match_id
    ) y;

  select count(*) into v_seen_before
    from public.rounds rr
   where rr.user_id = p_user_id and rr.state = 'resolved'
     and rr.player_choice is not null and rr.match_id <> p_match_id;

  v_ramp_start := coalesce(public.nemesis_setting('ramp_start_rounds'), 12);

  return jsonb_build_object(
    'match_id', p_match_id,
    'rounds',   v_rounds,
    -- The read scoreboard. This is what replaces staging losses: the blind
    -- rounds were genuinely blind, and saying so lets the player see that they
    -- out-played it rather than being let through.
    'read',     jsonb_build_object('rounds', v_read,  'you_won', v_read_won),
    'blind',    jsonb_build_object('rounds', v_blind, 'you_won', v_blind_won),
    'tell', case when v_model is null then null else jsonb_build_object(
      'model',    v_model,
      'context',  v_context,
      'rock',     round(coalesce(r.w_rock, 0)),
      'paper',    round(coalesce(r.w_paper, 0)),
      'scissors', round(coalesce(r.w_scissors, 0)),
      'total',    round(coalesce(r.w_total, 0))) end,
    'predictability', jsonb_build_object(
      'before', round(v_before, 3),
      'after',  round(v_after, 3)),
    -- Cold start, stated rather than hidden. A player who is being met by a
    -- blind opponent should be told so, not left to wonder why it felt easy.
    'calibrating',       v_seen_before < v_ramp_start,
    'rounds_until_read', greatest(0, (v_ramp_start - v_seen_before)::int)
  );
end $$;
revoke all on function public.nemesis_match_report(uuid, uuid) from public, anon, authenticated;

-- Keep the trophy current whenever the metrics are recomputed. Only once the
-- score means anything: below the confidence floor a low number is noise, and
-- enshrining noise as a personal best would make the trophy unbeatable by
-- actually improving.
create or replace function public.nemesis_touch_best(p_user_id uuid)
returns void
language sql security definer set search_path to '' as $$
  update public.player_skill_metrics psm
     set lowest_predictability =
           least(coalesce(psm.lowest_predictability, psm.predictability_score),
                 psm.predictability_score),
         lowest_predictability_at =
           case when psm.lowest_predictability is null
                  or psm.predictability_score < psm.lowest_predictability
                then now() else psm.lowest_predictability_at end
   where psm.user_id = p_user_id
     and psm.predictability_score is not null
     and psm.confidence <> 'calibrating';
$$;
revoke all on function public.nemesis_touch_best(uuid) from public, anon, authenticated;
