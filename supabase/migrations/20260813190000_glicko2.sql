-- Skill layer, part 3 of the EVENSHOCK-SKILL-LAYER brief: Glicko-2.
--
-- WHAT IS RATEABLE, AND WHY IT IS NOT WHAT THE BRIEF ASSUMED
--
-- The brief says "rate on match result (bo5 outcome)". Taken literally that
-- includes solo matches, and it must not, for a reason that is the brief's own
-- argument turned on the ladder:
--
--   The solo opponent's throw is drawn with crypto.getRandomValues in the play
--   Edge Function and committed to before the player moves. It is UNIFORM
--   RANDOM. Against a uniform-random opponent, every rock-paper-scissors
--   strategy has identical expected value — 1/3 win, 1/3 tie, 1/3 loss. There
--   is no play that beats a coin.
--
-- So a solo result carries exactly zero bits about skill. Rating on it would
-- march every player towards 1500 while their RD shrank, which is worse than
-- useless: it manufactures confidence in a number that measures nothing. And a
-- ladder whose ranks are decided by chance outcomes is the precise object that
-- has `stake_tables` frozen — building it would recreate the legal problem
-- inside the system meant to answer it.
--
-- Therefore ratings come from `mp_tables` — human against human — only. Solo
-- play still feeds `player_skill_metrics`, and that is not a contradiction:
-- predictability is measured from the player's OWN sequence, which is just as
-- real when the opponent is a dice roll. You can learn whether someone is
-- readable by watching them play a coin. You cannot learn whether they can
-- read, or who is better, and only the second thing is a ladder.
--
-- The practical consequence, stated plainly because it will look like a bug:
-- `mp_tables` holds 0 rows today, so the ladder is legitimately EMPTY. That is
-- the honest output of this design, not a failure of it.
--
-- WHY GLICKO-2 AND NOT ELO
--
-- Elo carries a rating and nothing else, so it cannot tell a 1500 who has
-- played 400 games from a 1500 who has played none, and it moves both by the
-- same amount. Glicko-2 carries a rating deviation and a volatility, which is
-- what makes the cold start and the player who vanishes for a month behave
-- correctly rather than merely not crash — RD widens with absence, so a
-- returning player's first result moves them a lot and the ladder re-finds
-- them quickly.
--
-- The implementation is Glickman's paper step for step, including the Illinois
-- root-finder for the volatility update, and it is verified against the worked
-- example in that paper. An unverified rating implementation is
-- indistinguishable from a plausible-looking one.
--
-- ON THE LAST DECIMAL, because it will look like a failure otherwise: the paper
-- prints r' = 1464.06 and this returns 1464.0507. The difference is the paper's
-- own rounding, not a defect. Glickman carries intermediates at 4 decimals and
-- reports mu' = -0.2069; the unrounded value is -0.206941, and 173.7178 times
-- that difference is the missing hundredth. Feeding the paper's rounded mu'
-- back through the scale conversion gives 1464.0578, which is where its 1464.06
-- comes from. So the fixtures assert on mu' and phi' at the 4 decimals the
-- paper actually publishes, rather than on a 2-decimal rating that encodes
-- someone else's rounding error. Cross-checked against an independent float64
-- implementation, which agrees with this one to all six decimals.

-- g(phi): how much an opponent's own uncertainty flattens the expected score.
create or replace function public.glicko2_g(p_phi double precision)
returns double precision
language sql immutable strict parallel safe set search_path to '' as $$
  select 1.0 / sqrt(1.0 + 3.0 * p_phi * p_phi / (pi() * pi()));
$$;

-- E: expected score against one opponent, on the Glicko-2 scale.
create or replace function public.glicko2_e(
  p_mu double precision, p_mu_j double precision, p_phi_j double precision
) returns double precision
language sql immutable strict parallel safe set search_path to '' as $$
  select 1.0 / (1.0 + exp(-public.glicko2_g(p_phi_j) * (p_mu - p_mu_j)));
$$;

-- The function whose root is the new volatility (Glickman, step 5). Split out
-- rather than inlined because the root-finder evaluates it at four different
-- points and a copy-pasted expression is where sign errors live.
create or replace function public.glicko2_f(
  p_x     double precision,
  p_delta double precision,
  p_phi   double precision,
  p_v     double precision,
  p_a     double precision,
  p_tau   double precision
) returns double precision
language sql immutable strict parallel safe set search_path to '' as $$
  select (exp(p_x) * (p_delta * p_delta - p_phi * p_phi - p_v - exp(p_x)))
           / (2.0 * (p_phi * p_phi + p_v + exp(p_x)) * (p_phi * p_phi + p_v + exp(p_x)))
         - (p_x - p_a) / (p_tau * p_tau);
$$;

-- One rating period for one player.
--
-- p_opponents: [{"rating": 1400, "rd": 30, "score": 1}, ...] where score is
-- 1 win, 0.5 draw, 0 loss. An EMPTY array is meaningful and supported: it is
-- the "did not play this period" case, which widens RD and leaves the rating
-- alone. That path is why an intermittent player is handled correctly instead
-- of merely tolerated.
create or replace function public.glicko2_update(
  p_rating     numeric,
  p_rd         numeric,
  p_volatility numeric,
  p_opponents  jsonb,
  p_tau        double precision default 0.5
) returns jsonb
language plpgsql immutable parallel safe set search_path to '' as $$
declare
  -- The Glicko-2 scale factor: 400/ln(10). Ratings are stored on the familiar
  -- 1500-centred scale and converted in and out, so nothing downstream has to
  -- know this number exists.
  c_scale  constant double precision := 173.7178;
  -- An unrated player's RD. Also the ceiling: absence should stop widening the
  -- interval once it is already "we know nothing", and without a cap a dormant
  -- account's RD grows without bound and its return swings the ladder.
  c_rd_max constant double precision := 350.0;
  c_eps    constant double precision := 0.000001;

  v_mu     double precision := (p_rating::double precision - 1500.0) / c_scale;
  v_phi    double precision := p_rd::double precision / c_scale;
  -- Guarded: ln(sigma^2) is taken below, and a zero or negative volatility
  -- from a bad row would take the whole finalization down with it.
  v_sigma  double precision := greatest(p_volatility::double precision, 0.000001);

  v_inv    double precision := 0.0;   -- 1/v, accumulated
  v_dsum   double precision := 0.0;   -- sum of g_j * (s_j - E_j)
  v_n      int := 0;
  v_v      double precision;
  v_delta  double precision;
  -- Named v_anchor rather than the paper's `a`: plpgsql identifiers are
  -- case-insensitive, so `v_a` and the bracket endpoint `v_A` would be one
  -- variable quietly overwriting itself.
  v_anchor double precision;
  v_lo     double precision;
  v_hi     double precision;
  v_mid    double precision;
  v_f_lo   double precision;
  v_f_hi   double precision;
  v_f_mid  double precision;
  v_k      int := 1;
  v_iter   int := 0;
  v_phistar double precision;
  v_phinew  double precision;
  v_munew   double precision;
  v_muj    double precision;
  v_phij   double precision;
  v_gj     double precision;
  v_ej     double precision;
  o        record;
begin
  for o in
    select (e ->> 'rating')::double precision as rating,
           (e ->> 'rd')::double precision     as rd,
           (e ->> 'score')::double precision  as score
      from jsonb_array_elements(coalesce(p_opponents, '[]'::jsonb)) as e
  loop
    v_muj  := (o.rating - 1500.0) / c_scale;
    v_phij := o.rd / c_scale;
    v_gj   := public.glicko2_g(v_phij);
    v_ej   := 1.0 / (1.0 + exp(-v_gj * (v_mu - v_muj)));
    v_inv  := v_inv + v_gj * v_gj * v_ej * (1.0 - v_ej);
    v_dsum := v_dsum + v_gj * (o.score - v_ej);
    v_n    := v_n + 1;
  end loop;

  -- No games (or a degenerate set carrying no information): step 6 alone.
  if v_n = 0 or v_inv <= 0.0 then
    v_phinew := sqrt(v_phi * v_phi + v_sigma * v_sigma);
    return jsonb_build_object(
      'rating',     round((c_scale * v_mu + 1500.0)::numeric, 6),
      'rd',         round(least(c_scale * v_phinew, c_rd_max)::numeric, 6),
      'volatility', round(v_sigma::numeric, 6),
      'games',      0
    );
  end if;

  v_v      := 1.0 / v_inv;
  v_delta  := v_v * v_dsum;
  v_anchor := ln(v_sigma * v_sigma);

  -- Bracket the root. The upper branch is Glickman's: when the observed swing
  -- is bigger than the variance can explain, the root is above the anchor and
  -- can be named outright; otherwise walk down in steps of tau until f turns.
  v_lo := v_anchor;
  if v_delta * v_delta > v_phi * v_phi + v_v then
    v_hi := ln(v_delta * v_delta - v_phi * v_phi - v_v);
  else
    while public.glicko2_f(v_anchor - v_k * p_tau, v_delta, v_phi, v_v, v_anchor, p_tau) < 0.0
          and v_k < 100 loop
      v_k := v_k + 1;
    end loop;
    v_hi := v_anchor - v_k * p_tau;
  end if;

  -- Illinois: regula falsi with the stalling-endpoint fix. Bounded because an
  -- unbounded loop inside match finalization is a hang, not a bug report.
  v_f_lo := public.glicko2_f(v_lo, v_delta, v_phi, v_v, v_anchor, p_tau);
  v_f_hi := public.glicko2_f(v_hi, v_delta, v_phi, v_v, v_anchor, p_tau);
  while abs(v_hi - v_lo) > c_eps and v_iter < 100 loop
    v_mid   := v_lo + (v_lo - v_hi) * v_f_lo / (v_f_hi - v_f_lo);
    v_f_mid := public.glicko2_f(v_mid, v_delta, v_phi, v_v, v_anchor, p_tau);
    if v_f_mid * v_f_hi <= 0.0 then
      v_lo := v_hi; v_f_lo := v_f_hi;
    else
      v_f_lo := v_f_lo / 2.0;
    end if;
    v_hi := v_mid; v_f_hi := v_f_mid;
    v_iter := v_iter + 1;
  end loop;

  v_sigma   := exp(v_lo / 2.0);
  v_phistar := sqrt(v_phi * v_phi + v_sigma * v_sigma);
  v_phinew  := 1.0 / sqrt(1.0 / (v_phistar * v_phistar) + 1.0 / v_v);
  v_munew   := v_mu + v_phinew * v_phinew * v_dsum;

  return jsonb_build_object(
    'rating',     round((c_scale * v_munew + 1500.0)::numeric, 6),
    'rd',         round(least(c_scale * v_phinew, c_rd_max)::numeric, 6),
    'volatility', round(v_sigma::numeric, 6),
    'games',      v_n
  );
end $$;
comment on function public.glicko2_update(numeric, numeric, numeric, jsonb, double precision) is
  'One Glicko-2 rating period. Verified against the worked example in '
  'Glickman''s paper: 1500/200/0.06 vs (1400,30,W) (1550,100,L) (1700,300,L) '
  '-> 1464.0507 / 151.5165 / 0.059996, i.e. mu''=-0.206941 phi''=0.872199 '
  'against the paper''s 4-decimal -0.2069 / 0.8722.';

-- ------------------------------------------------------------- who may rank
-- Harness and owner accounts play to prove the system works, not to compete.
-- One definition, used by the rating pipeline, the leaderboard and the
-- tournament seeding alike — the brief says "filter them everywhere", and
-- three copies of a filter is three chances to forget one.
create or replace function public.is_rateable_player(p_user_id uuid)
returns boolean
language sql stable parallel safe set search_path to '' as $$
  select coalesce(
    (select not (p.is_harness or p.is_owner) from public.profiles p where p.id = p_user_id),
    false
  );
$$;
comment on function public.is_rateable_player(uuid) is
  'False for harness and owner accounts, and for a user_id with no profile.';
