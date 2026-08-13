-- Skill layer, part 2 of the EVENSHOCK-SKILL-LAYER brief: the measurement.
--
-- WHY THE SCORES ARE WIN-RATES AND NOT ENTROPY
--
-- The obvious way to score "how predictable is this player" is an entropy
-- deficit. It was rejected: 0.31 bits means nothing to a player, and worse, it
-- means nothing to a lawyer either. Both scores here are stated in the only
-- unit that carries its own argument —
--
--   predictability_score = how much better than a coin flip a PERFECT READER
--                          would do against this player, rescaled 0..1.
--                          0.0 = unexploitable, 0.6 = a reader scores 0.8.
--   read_score           = how much better than chance this player picks the
--                          counter to the opponent's most likely throw,
--                          rescaled 0..1. 0.0 = chance, 1.0 = perfect.
--
-- That is the whole skill claim in two numbers, and each one is falsifiable by
-- simulation rather than by argument.
--
-- SMALL SAMPLES LIE TOWARDS SKILL-LOOKS-LIKE-CHANCE'S OPPOSITE
--
-- Three throws of rock is not evidence of a rock player, but an unsmoothed
-- estimator scores it 1.0 — maximally exploitable — and the ladder would open
-- with a leaderboard of people who played once. Every context distribution
-- here is Dirichlet-smoothed (alpha = 0.5, Jeffreys) BEFORE it is scored, so a
-- thin context is pulled towards uniform in proportion to how thin it is. This
-- is what makes the finer-grained models safe to include: a conditional model
-- splits the same rounds across three contexts, so its evidence per context is
-- a third as strong, and the smoothing bites three times as hard on its own.
-- No separate overfitting penalty is needed.
--
-- The `confidence` column is a SECOND gate, not the same one. Smoothing keeps
-- the number honest; confidence tells the UI whether to show it at all.
--
-- WHY max() ACROSS MODELS AND NOT THE AVERAGE
--
-- Three models are fitted: the player's marginal distribution, their
-- distribution given their own previous throw, and their distribution given
-- the previous round's outcome. Exploitability is the MAXIMUM across them,
-- because a real opponent uses the best read available, not the average of
-- their options. A player who cycles rock-paper-scissors strictly has a
-- perfectly uniform marginal — averaging would score them unexploitable, which
-- is the exact opposite of the truth. Under max() they score ~0.87.

-- What beats what. One definition, referenced by both scorers, so a rules
-- change cannot half-land.
create or replace function public.rps_beats(p_move text)
returns text language sql immutable strict parallel safe as $$
  select case p_move
           when 'rock'     then 'paper'
           when 'paper'    then 'scissors'
           when 'scissors' then 'rock'
         end;
$$;
comment on function public.rps_beats(text) is
  'The move that beats p_move. NULL for anything that is not a move.';

-- ------------------------------------------------------------ predictability
-- Pure: takes sequences, touches no rows, so it can be tested against
-- hand-built fixtures where the right answer is known by construction.
--
-- The caller supplies the context columns already aligned and already broken
-- at match boundaries (NULL prev_* = no in-match predecessor). Keeping the
-- boundary logic in the caller is what keeps this function testable with
-- literal arrays.
create or replace function public.skill_predictability(
  p_moves         text[],
  p_prev_moves    text[],
  p_prev_outcomes text[]
) returns numeric
language sql immutable parallel safe set search_path to '' as $$
  with obs as (
    select p_moves[i]         as move,
           p_prev_moves[i]    as prev_move,
           p_prev_outcomes[i] as prev_outcome
      from generate_subscripts(p_moves, 1) as g(i)
     where p_moves[i] is not null
  ),
  -- One row per (model, context, observed move). A context is a situation an
  -- opponent could condition on.
  ctx as (
    select 'marginal'::text as model, ''::text as context, move from obs
    union all
    select 'prev_move', prev_move, move from obs where prev_move is not null
    union all
    select 'prev_outcome', prev_outcome, move from obs where prev_outcome is not null
  ),
  counts as (
    select model, context,
           count(*) filter (where move = 'rock')     as n_rock,
           count(*) filter (where move = 'paper')    as n_paper,
           count(*) filter (where move = 'scissors') as n_scissors,
           count(*)                                  as n_ctx
      from ctx
     group by model, context
  ),
  -- Expected score of a reader who commits to one prediction in this context,
  -- with win = 1, tie = 0.5, loss = 0. Predicting X means throwing beats(X):
  -- the player's X is beaten (1), the player's beats(X) ties (0.5), and the
  -- third move beats us (0). So V(X) = p(X) + 0.5 * p(beats(X)).
  -- Denominator n_ctx + 3*alpha is never zero: a context only exists if it has
  -- at least one observation.
  value as (
    select model, n_ctx,
           greatest(
             ((n_rock     + 0.5) + 0.5 * (n_paper    + 0.5)) / (n_ctx + 1.5),
             ((n_paper    + 0.5) + 0.5 * (n_scissors + 0.5)) / (n_ctx + 1.5),
             ((n_scissors + 0.5) + 0.5 * (n_rock     + 0.5)) / (n_ctx + 1.5)
           ) as v
      from counts
  ),
  per_model as (
    select model, sum(v * n_ctx) / sum(n_ctx) as v_model
      from value
     group by model
  )
  -- Rescale: 0.5 (a coin flip, the reader learns nothing) -> 0, 1.0 -> 1.
  -- Clamped because smoothing can leave a hair under 0.5 on a context that
  -- happens to sit slightly against the reader.
  select max(least(greatest((v_model - 0.5) / 0.5, 0), 1)) from per_model;
$$;
comment on function public.skill_predictability(text[], text[], text[]) is
  'How exploitable a throw sequence is, 0..1. 0 = a perfect reader does no '
  'better than chance; 1 = a perfect reader always wins. NULL on no data.';

-- ---------------------------------------------------------------- read score
-- Counted over ONE match. Opponent history is scoped to the match in progress
-- deliberately: that is the information the player actually had in front of
-- them at the moment they threw. Crediting a read the player could not have
-- made would flatter them, and this number has to survive an adversary.
--
-- Rounds where the opponent's prior throws have no unique mode (round 1
-- always, and any tie) are not opportunities at all — they are dropped from
-- the denominator rather than scored as misses, because there was nothing to
-- read. Returning hits and opportunities separately, rather than a rate, is
-- what lets the caller aggregate across matches without weighting a 2-round
-- match the same as a 5-round one.
create or replace function public.skill_read_rate_match(
  p_player_moves   text[],
  p_opponent_moves text[]
) returns jsonb
language sql immutable parallel safe set search_path to '' as $$
  with plays as (
    select i, p_player_moves[i] as mine, p_opponent_moves[i] as theirs
      from generate_subscripts(p_player_moves, 1) as g(i)
  ),
  -- Opponent's throws STRICTLY BEFORE this round. The self-join is the whole
  -- causality guarantee, so it is a join condition and not a filter applied
  -- later.
  hist as (
    select p.i, p.mine,
           count(*) filter (where h.theirs = 'rock')     as n_rock,
           count(*) filter (where h.theirs = 'paper')    as n_paper,
           count(*) filter (where h.theirs = 'scissors') as n_scissors
      from plays p
      left join plays h on h.i < p.i and h.theirs is not null
     where p.mine is not null
     group by p.i, p.mine
  ),
  pred as (
    select i, mine,
           case
             when n_rock     > n_paper and n_rock     > n_scissors then 'rock'
             when n_paper    > n_rock  and n_paper    > n_scissors then 'paper'
             when n_scissors > n_rock  and n_scissors > n_paper    then 'scissors'
           end as predicted
      from hist
  )
  select jsonb_build_object(
           'opportunities', count(*) filter (where predicted is not null),
           'hits',          count(*) filter (where predicted is not null
                                               and mine = public.rps_beats(predicted))
         )
    from pred;
$$;
comment on function public.skill_read_rate_match(text[], text[]) is
  'Per-match read counting: {hits, opportunities}. An opportunity is a round '
  'where the opponent''s earlier throws in this match had a unique mode.';

-- --------------------------------------------------- what the aggregate reads
-- read_score is a rate, and a rate with no denominator cannot be audited.
-- Storing the counts is what lets anyone re-derive the score by hand.
alter table public.player_skill_metrics
  add column if not exists read_hits         int not null default 0,
  add column if not exists read_opportunities int not null default 0;

-- ------------------------------------------------------------- the aggregator
-- Recomputes one player from their rounds. Idempotent by construction: it
-- derives everything from scratch every time rather than incrementing, so a
-- missed call or a double call both land on the same answer. That matters
-- because it is about to be wired into match finalization, where an
-- incremental version would drift permanently on any error.
create or replace function public.refresh_player_skill_metrics(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_moves    text[];
  v_prev     text[];
  v_prevout  text[];
  v_pred     numeric;
  v_rounds   int;
  v_matches  int := 0;
  v_wins     int := 0;
  v_winrate  numeric;
  v_hits     bigint := 0;
  v_opps     bigint := 0;
  v_read     numeric;
  v_conf     text;
  v_counted  jsonb;
  r          record;
begin
  -- The player's own throws in play order, each carrying the context an
  -- opponent could have conditioned on. lag() is partitioned by match, so the
  -- last round of one match is never treated as the predecessor of the first
  -- round of the next — a boundary that would invent a pattern out of nothing.
  select array_agg(move order by ord),
         array_agg(prev_move order by ord),
         array_agg(prev_outcome order by ord)
    into v_moves, v_prev, v_prevout
    from (
      select row_number() over (order by m.created_at, r2.round_number) as ord,
             r2.player_choice as move,
             lag(r2.player_choice) over (partition by r2.match_id order by r2.round_number) as prev_move,
             lag(r2.outcome)       over (partition by r2.match_id order by r2.round_number) as prev_outcome
        from public.rounds r2
        join public.matches m on m.id = r2.match_id
       where r2.user_id = p_user_id
         and r2.state = 'resolved'
         and r2.player_choice is not null
    ) s;

  v_rounds := coalesce(array_length(v_moves, 1), 0);
  v_pred   := public.skill_predictability(v_moves, v_prev, v_prevout);

  -- Reads are counted per match and summed, never averaged over matches: a
  -- 5-round match offers more chances to read than a 2-round one and should
  -- weigh more.
  for r in
    select r3.match_id,
           array_agg(r3.player_choice   order by r3.round_number) as mine,
           array_agg(r3.opponent_choice order by r3.round_number) as theirs
      from public.rounds r3
     where r3.user_id = p_user_id
       and r3.state = 'resolved'
     group by r3.match_id
  loop
    v_counted := public.skill_read_rate_match(r.mine, r.theirs);
    v_hits := v_hits + (v_counted ->> 'hits')::bigint;
    v_opps := v_opps + (v_counted ->> 'opportunities')::bigint;
  end loop;

  -- Under 20 chances to read, the rate is noise wearing a number's clothes.
  -- NULL says "not measured", which is different from 0.0 = "no better than
  -- chance", and the difference is worth a column.
  v_read := case when v_opps >= 20
                 then least(greatest((v_hits::numeric / v_opps - 1.0/3.0) / (2.0/3.0), 0), 1)
            end;

  select count(*), count(*) filter (where mm.result = 'win')
    into v_matches, v_wins
    from public.matches mm
   where mm.user_id = p_user_id and mm.status = 'complete';

  v_winrate := case when v_matches > 0 then v_wins::numeric / v_matches end;

  -- The brief's ~30-round floor. Below it the UI shows "calibrating" and no
  -- rating at all.
  v_conf := case when v_rounds >= 500 then 'high'
                 when v_rounds >= 100 then 'medium'
                 when v_rounds >= 30  then 'low'
                 else 'calibrating' end;

  insert into public.player_skill_metrics as psm (
    user_id, predictability_score, read_score, read_hits, read_opportunities,
    matches_played, rounds_played, win_rate, confidence, last_calculated_at
  ) values (
    p_user_id, v_pred, v_read, v_hits, v_opps,
    v_matches, v_rounds, v_winrate, v_conf, now()
  )
  on conflict (user_id) do update set
    predictability_score = excluded.predictability_score,
    read_score           = excluded.read_score,
    read_hits            = excluded.read_hits,
    read_opportunities   = excluded.read_opportunities,
    matches_played       = excluded.matches_played,
    rounds_played        = excluded.rounds_played,
    win_rate             = excluded.win_rate,
    confidence           = excluded.confidence,
    last_calculated_at   = excluded.last_calculated_at;

  return jsonb_build_object(
    'user_id',              p_user_id,
    'predictability_score', v_pred,
    'read_score',           v_read,
    'read_hits',            v_hits,
    'read_opportunities',   v_opps,
    'matches_played',       v_matches,
    'rounds_played',        v_rounds,
    'win_rate',             v_winrate,
    'confidence',           v_conf
  );
end $$;

-- The aggregator reads other people's rounds to build a player's own metrics,
-- so it is definer and no client may call it. The two pure scorers take
-- literal arrays and reach no table at all — those stay callable, which is
-- what lets the fixture suite run as an ordinary client rather than needing
-- the service role to prove the maths.
revoke all on function public.refresh_player_skill_metrics(uuid) from public, anon, authenticated;

-- Backfill / repair entry point. Returns one row per player so a run is
-- inspectable rather than a silent success.
create or replace function public.refresh_all_player_skill_metrics()
returns setof jsonb
language sql security definer set search_path to '' as $$
  select public.refresh_player_skill_metrics(p.id)
    from public.profiles p
   where exists (select 1 from public.rounds r where r.user_id = p.id and r.state = 'resolved');
$$;
revoke all on function public.refresh_all_player_skill_metrics() from public, anon, authenticated;
