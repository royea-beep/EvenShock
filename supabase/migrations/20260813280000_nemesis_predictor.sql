-- NEMESIS, part 2: the predictor — and the fourth model, in BOTH places.
--
-- ONE FUNCTION, TWO WINDOWS. `skill_predictability` answers "how readable has
-- this player been overall". Nemesis answers "how readable are they right
-- now". Those are the same question over different windows, so they are the
-- same code with a decay parameter: the metric passes NULL (no decay), Nemesis
-- passes a half-life. If they were two implementations, the score on a
-- player's profile would eventually describe an opponent nobody faced, and the
-- whole feedback loop — watch your predictability fall — would be a fiction.
--
-- WHY WINNER-TAKES-ALL AND NOT AN ENSEMBLE. The metric is defined as the
-- expected score of the BEST single-context reader. Nemesis is that reader,
-- throttled. A mixture would predict better and describe worse, and the
-- describing is half the value here: the model Nemesis selected, and the
-- counts in the context it looked at, ARE the post-match feedback. "After a
-- loss you threw rock 7 times out of 11" is not a generated tip, it is the
-- literal state that produced the throw.
--
-- The usual objection to winner-takes-all is that a context with three
-- observations looks certain and hijacks the prediction. Jeffreys smoothing is
-- the answer: three observations barely move off uniform, so a thin context
-- cannot win the selection.
--
-- THE FOURTH MODEL, and why it is not a hard-coded rule. "Losers switch,
-- winners repeat" is the classic human tell, and it is invisible to all three
-- existing models: it lives in the JOINT of (previous outcome x previous
-- throw), and neither marginal captures it. Hard-coding the folk rule would
-- assert it about players who do not do it. A model over the nine joint
-- contexts LEARNS it when the player has it and ignores it when they do not —
-- strictly better, same framework, no special case.
--
-- SCORE DISCONTINUITY, RECORDED DELIBERATELY: adding a fourth model raises
-- every predictability score slightly, because the metric is a max over models.
-- Scores from before this migration are NOT comparable with scores after it.
-- At the time of writing that touches 17 harness accounts and zero players, so
-- this is the cheapest moment this change will ever be available.

-- ------------------------------------------------------- the shared evidence
-- Weighted counts per (model, context). The weight is 1 for the most recent
-- observation and decays with age when a half-life is given; passing NULL
-- makes every observation count equally, which is what a lifetime metric
-- wants.
create or replace function public.skill_context_stats(
  p_moves         text[],
  p_prev_moves    text[],
  p_prev_outcomes text[],
  p_half_life     numeric default null
) returns table (
  model      text,
  context    text,
  w_rock     numeric,
  w_paper    numeric,
  w_scissors numeric,
  w_total    numeric
)
language sql immutable parallel safe set search_path to '' as $$
  with len as (select coalesce(array_length(p_moves, 1), 0) as n),
  obs as (
    select p_moves[i]         as move,
           p_prev_moves[i]    as prev_move,
           p_prev_outcomes[i] as prev_outcome,
           case when p_half_life is null or p_half_life <= 0 then 1.0
                else power(0.5::numeric, ((len.n - i)::numeric) / p_half_life)
           end as w
      from len, generate_subscripts(p_moves, 1) as g(i)
     where p_moves[i] is not null
  ),
  ctx as (
    select 'marginal'::text as model, ''::text as context, move, w from obs
    union all
    select 'prev_move', prev_move, move, w from obs where prev_move is not null
    union all
    select 'prev_outcome', prev_outcome, move, w from obs where prev_outcome is not null
    union all
    -- The joint model. Win-stay/lose-shift lives here if the player has it,
    -- and nowhere if they do not.
    select 'prev_outcome_move', prev_outcome || '|' || prev_move, move, w
      from obs where prev_outcome is not null and prev_move is not null
  )
  select model, context,
         coalesce(sum(w) filter (where move = 'rock'), 0),
         coalesce(sum(w) filter (where move = 'paper'), 0),
         coalesce(sum(w) filter (where move = 'scissors'), 0),
         sum(w)
    from ctx
   group by model, context;
$$;

-- ------------------------------------------------------------ the metric
-- Unchanged in meaning, now reading four models instead of three and sharing
-- its arithmetic with the opponent. Still: how much better than a coin flip a
-- perfect reader would do against this sequence, rescaled 0..1.
create or replace function public.skill_predictability(
  p_moves         text[],
  p_prev_moves    text[],
  p_prev_outcomes text[]
) returns numeric
language sql immutable parallel safe set search_path to '' as $$
  with value as (
    select model, w_total,
           greatest(
             ((w_rock     + 0.5) + 0.5 * (w_paper    + 0.5)) / (w_total + 1.5),
             ((w_paper    + 0.5) + 0.5 * (w_scissors + 0.5)) / (w_total + 1.5),
             ((w_scissors + 0.5) + 0.5 * (w_rock     + 0.5)) / (w_total + 1.5)
           ) as v
      from public.skill_context_stats(p_moves, p_prev_moves, p_prev_outcomes, null)
  ),
  per_model as (
    select model, sum(v * w_total) / nullif(sum(w_total), 0) as v_model
      from value group by model
  )
  select max(least(greatest((v_model - 0.5) / 0.5, 0), 1)) from per_model;
$$;

-- ---------------------------------------------------------------- the read
-- Selects the lens that reads this player best over their history, then looks
-- up what that lens says about the situation in front of it right now.
--
-- TIE-BREAKING is deterministic (rock, then paper, then scissors) rather than
-- random, so tests are not flaky. A tie is only reachable in a context with
-- effectively no evidence, and the cold-start ramp holds exploitation at zero
-- there — but it is worth knowing that an unseen context makes Nemesis
-- momentarily predictable, and that a player who notices and exploits it is
-- doing exactly the reading this mode is meant to reward.
create or replace function public.nemesis_predict(
  p_moves            text[],
  p_prev_moves       text[],
  p_prev_outcomes    text[],
  p_ctx_prev_move    text,
  p_ctx_prev_outcome text,
  p_half_life        numeric
) returns jsonb
language plpgsql stable parallel safe set search_path to '' as $$
declare
  v_model text;
  v_ctx   text;
  r       record;
  v_den   numeric;
  v_pr numeric; v_pp numeric; v_ps numeric;
  v_pred  text;
begin
  -- 1. Which lens reads this player best, over their whole (decayed) history.
  select pm.model into v_model
    from (
      select x.model, sum(x.v * x.w_total) / nullif(sum(x.w_total), 0) as v_model
        from (
          select s.model, s.w_total,
                 greatest(
                   ((s.w_rock     + 0.5) + 0.5 * (s.w_paper    + 0.5)) / (s.w_total + 1.5),
                   ((s.w_paper    + 0.5) + 0.5 * (s.w_scissors + 0.5)) / (s.w_total + 1.5),
                   ((s.w_scissors + 0.5) + 0.5 * (s.w_rock     + 0.5)) / (s.w_total + 1.5)
                 ) as v
            from public.skill_context_stats(p_moves, p_prev_moves, p_prev_outcomes, p_half_life) s
        ) x
       group by x.model
    ) pm
   order by pm.v_model desc nulls last, pm.model
   limit 1;

  if v_model is null then
    return jsonb_build_object('model', null, 'context', null, 'predicted', null,
                              'counter', null, 'ctx_weight', 0);
  end if;

  -- 2. What that lens is looking at for THIS round.
  v_ctx := case v_model
             when 'marginal'          then ''
             when 'prev_move'         then p_ctx_prev_move
             when 'prev_outcome'      then p_ctx_prev_outcome
             when 'prev_outcome_move' then
               case when p_ctx_prev_outcome is null or p_ctx_prev_move is null then null
                    else p_ctx_prev_outcome || '|' || p_ctx_prev_move end
           end;

  -- 3. Look it up. Round one has no predecessor and a context can be one this
  --    player has never been in; both fall back to the marginal lens rather
  --    than guessing.
  if v_ctx is not null then
    select * into r
      from public.skill_context_stats(p_moves, p_prev_moves, p_prev_outcomes, p_half_life) s
     where s.model = v_model and s.context = v_ctx;
  end if;

  if v_ctx is null or not found then
    v_model := 'marginal';
    v_ctx   := '';
    select * into r
      from public.skill_context_stats(p_moves, p_prev_moves, p_prev_outcomes, p_half_life) s
     where s.model = 'marginal' and s.context = '';
  end if;

  if not found then
    return jsonb_build_object('model', null, 'context', null, 'predicted', null,
                              'counter', null, 'ctx_weight', 0);
  end if;

  v_den := r.w_total + 1.5;
  v_pr  := (r.w_rock     + 0.5) / v_den;
  v_pp  := (r.w_paper    + 0.5) / v_den;
  v_ps  := (r.w_scissors + 0.5) / v_den;

  v_pred := case when v_pr >= v_pp and v_pr >= v_ps then 'rock'
                 when v_pp >= v_ps                  then 'paper'
                 else 'scissors' end;

  return jsonb_build_object(
    'model',      v_model,
    'context',    v_ctx,
    'predicted',  v_pred,
    'counter',    public.rps_beats(v_pred),
    'ctx_weight', round(r.w_total, 4),
    'counts',     jsonb_build_object('rock', round(r.w_rock, 4),
                                     'paper', round(r.w_paper, 4),
                                     'scissors', round(r.w_scissors, 4))
  );
end $$;

-- ------------------------------------------------------- the round decision
-- Called at round OPEN, before the round row exists. Returns the counter it
-- would play and the rate at which it should be played; the caller supplies
-- the randomness and makes the coin flip.
--
-- IT CANNOT SEE THE CURRENT THROW, structurally and three times over: the
-- round row has not been inserted when this runs; the history query reads only
-- `state = 'resolved'`, and a round is 'open' with a NULL player_choice until
-- the player submits; and the move this informs is committed to, with the
-- digest in the player's hands, before they move. If Nemesis peeked, that
-- digest would not verify at reveal.
--
-- THE PREDICTION IS ALWAYS COMPUTED, never skipped when the rate is low or the
-- coin would land blind. Branching on it here would make round-open latency a
-- side channel announcing "it is reading you this round" — which is worth more
-- to a player than knowing the move itself.
create or replace function public.nemesis_open(p_user_id uuid, p_match_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  m           public.matches;
  v_moves     text[];
  v_prev      text[];
  v_prevout   text[];
  v_n         int;
  v_ctx_move  text;
  v_ctx_out   text;
  v_pred      jsonb;
  v_rate      numeric;
  v_start     numeric;
  v_full      numeric;
  v_half_life numeric;
begin
  select * into m from public.matches where id = p_match_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('exploit_rate', 0, 'counter', null, 'reason', 'not_found');
  end if;

  -- A random-opponent match short-circuits. This is a work difference between
  -- MODES, not within one: the player chose the mode, so it tells them nothing
  -- they did not already know.
  if m.opponent is distinct from 'nemesis' then
    return jsonb_build_object('exploit_rate', 0, 'counter', null, 'reason', 'random_opponent');
  end if;

  -- Lifetime solo history, in play order, with the in-match context each throw
  -- was made in. lag() partitions by match so the last round of one match is
  -- never treated as the predecessor of the first round of the next.
  select array_agg(move order by ord),
         array_agg(prev_move order by ord),
         array_agg(prev_outcome order by ord)
    into v_moves, v_prev, v_prevout
    from (
      select row_number() over (order by mm.created_at, r2.round_number) as ord,
             r2.player_choice as move,
             lag(r2.player_choice) over (partition by r2.match_id order by r2.round_number) as prev_move,
             lag(r2.outcome)       over (partition by r2.match_id order by r2.round_number) as prev_outcome
        from public.rounds r2
        join public.matches mm on mm.id = r2.match_id
       where r2.user_id = p_user_id
         and r2.state = 'resolved'
         and r2.player_choice is not null
    ) s;

  v_n := coalesce(array_length(v_moves, 1), 0);

  -- The situation in front of Nemesis right now: the previous round of THIS
  -- match. Null on round one, which sends the predictor to the marginal lens.
  select r3.player_choice, r3.outcome into v_ctx_move, v_ctx_out
    from public.rounds r3
   where r3.match_id = p_match_id and r3.state = 'resolved'
   order by r3.round_number desc
   limit 1;

  v_start     := coalesce(public.nemesis_setting('ramp_start_rounds'), 12);
  v_full      := coalesce(public.nemesis_setting('ramp_full_rounds'), 30);
  v_half_life := coalesce(public.nemesis_setting('half_life_rounds'), 8);
  v_rate      := coalesce(public.nemesis_setting('exploit_rate'), 0.35);

  -- The cold-start ramp. Below the floor Nemesis is exactly today's bot; it
  -- sharpens as it earns the right to.
  v_rate := v_rate * case
              when v_n < v_start          then 0
              when v_n >= v_full          then 1
              when v_full <= v_start      then 1
              else (v_n - v_start) / (v_full - v_start)
            end;

  v_pred := public.nemesis_predict(v_moves, v_prev, v_prevout, v_ctx_move, v_ctx_out, v_half_life);

  -- Nothing to read: fall all the way back to blind.
  if v_pred ->> 'counter' is null then
    v_rate := 0;
  end if;

  return v_pred || jsonb_build_object(
    'exploit_rate', round(v_rate, 6),
    'rounds_seen',  v_n,
    'reason',       'nemesis'
  );
end $$;
revoke all on function public.nemesis_open(uuid, uuid) from public, anon, authenticated;
