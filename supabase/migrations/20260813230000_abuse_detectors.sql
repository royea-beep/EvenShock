-- Skill layer, part 7 of the EVENSHOCK-SKILL-LAYER brief: anti-abuse.
--
-- The ladder is the product. If it can be farmed it is worth nothing, and a
-- worthless ladder is worse than no ladder because it still looks like one.
--
-- WHAT DIRECTION trust_score RUNS, decided here because it had to be
--
-- The column shipped on day one with `default 0` and the comment "Reserved. 0
-- for everyone until there is a rule worth scoring against." This is that rule,
-- so the direction has to stop being ambiguous. The name reads as "higher is
-- better"; the default reads as "everyone starts at zero". Those cannot both
-- be true without every account starting maximally untrusted.
--
-- Resolved as a SUSPICION score: 0 is clean, and every confirmed finding adds
-- to it. That is the only reading under which the existing default means what
-- it says. The column comment is rewritten below so the next person to touch
-- this cannot read it the other way round.
--
-- WHAT THIS CANNOT DETECT, STATED PLAINLY
--
-- The brief asks for shared-IP and shared-funding detection. Neither is
-- possible against the current schema, and no amount of query writing changes
-- that:
--
--   * NO IP IS EVER STORED. geo_verdicts keeps country_code, source,
--     is_datacenter and a decision — deliberately, it looks like, since that is
--     the minimum needed for the geo gate. There is no column, anywhere, that
--     could support "same IP on both seats". Adding one is a privacy decision
--     with retention consequences, not a detector, and is not mine to make.
--   * NO PAYER WALLET IS STORED. `payments` records signature, treasury
--     address, mint and the crediting user — the funding wallet is only on
--     chain. So "same wallet funded both sides" cannot be answered from the
--     database; it needs a chain lookup per payment, which is a different piece
--     of work with a rate-limited external dependency.
--
-- What IS detectable from what exists — who played whom, how often, in what
-- pattern, and how fast — is implemented below, and covers the three named
-- integrity kinds. The two gaps above are recorded rather than faked.

comment on column public.profiles.trust_score is
  'SUSPICION score, not a credit rating: 0 is clean and every confirmed abuse '
  'finding adds to it. Written only by apply_abuse_findings.';

-- ------------------------------------------------------------- the evidence
-- Everything the detectors reason about, in one read-only place. Returning the
-- raw shape rather than a verdict is deliberate: thresholds are policy and will
-- be argued about, but these numbers are facts and can be eyeballed before
-- anyone is flagged.
create or replace function public.abuse_pair_stats(p_min_games int default 5)
returns table (
  low_id         uuid,
  high_id        uuid,
  games          bigint,
  wins_low       bigint,
  wins_high      bigint,
  share_low      numeric,
  share_high     numeric,
  concentration  numeric,
  lopsided       numeric,
  alternation    numeric,
  median_seconds numeric
)
language sql stable security definer set search_path to '' as $$
  with decided as (
    select least(seat_a, seat_b)    as low_id,
           greatest(seat_a, seat_b) as high_id,
           case when result = 'a' then seat_a else seat_b end as winner,
           coalesce(finalized_at, settled_at, created_at) as at,
           extract(epoch from (coalesce(finalized_at, settled_at) - created_at)) as seconds
      from public.mp_tables
     where settlement = 'decided' and seat_b is not null and result is not null
  ),
  seq as (
    select d.*,
           (d.winner = d.low_id) as low_won,
           lag((d.winner = d.low_id)) over (
             partition by d.low_id, d.high_id order by d.at
           ) as prev_low_won
      from decided d
  ),
  pair as (
    select s.low_id, s.high_id,
           count(*)                                              as games,
           count(*) filter (where s.low_won)                      as wins_low,
           count(*) filter (where not s.low_won)                  as wins_high,
           -- A perfectly alternating result string is the signature of two
           -- accounts trading wins to move ratings without either losing chips
           -- on net. Random play flips about half the time.
           count(*) filter (where s.prev_low_won is not null
                              and s.low_won <> s.prev_low_won)    as flips,
           count(*) filter (where s.prev_low_won is not null)     as flip_chances,
           percentile_cont(0.5) within group (order by s.seconds) as median_seconds
      from seq s
     group by s.low_id, s.high_id
  ),
  totals as (
    select user_id, count(*) as total
      from (select low_id as user_id from decided
            union all
            select high_id from decided) x
     group by user_id
  )
  select p.low_id, p.high_id, p.games, p.wins_low, p.wins_high,
         round(p.games::numeric / tl.total, 3),
         round(p.games::numeric / th.total, 3),
         -- Concentration is the WEAKER of the two shares. A newcomer whose only
         -- two games happen to be against a regular is not colluding; it takes
         -- both sides being unusually devoted to each other to mean anything.
         least(round(p.games::numeric / tl.total, 3), round(p.games::numeric / th.total, 3)),
         round(abs(p.wins_low - p.wins_high)::numeric / p.games, 3),
         case when p.flip_chances > 0 then round(p.flips::numeric / p.flip_chances, 3) end,
         round(p.median_seconds::numeric, 1)
    from pair p
    join totals tl on tl.user_id = p.low_id
    join totals th on th.user_id = p.high_id
   where p.games >= greatest(1, p_min_games);
$$;
revoke all on function public.abuse_pair_stats(int) from public, anon, authenticated;

-- ------------------------------------------------------------- the verdicts
create or replace function public.detect_abuse(
  p_min_games      int     default 5,
  p_concentration  numeric default 0.5,
  p_lopsided       numeric default 0.8,
  p_alternation    numeric default 0.8,
  p_fast_seconds   numeric default 10
)
returns table (kind text, low_id uuid, high_id uuid, detail jsonb)
language sql stable security definer set search_path to '' as $$
  with s as (select * from public.abuse_pair_stats(p_min_games))
  -- One pair can earn more than one verdict, and should: dumping and speed are
  -- different accusations with different remedies.
  select 'collusion_suspected', s.low_id, s.high_id,
         jsonb_build_object('reason', 'lopsided results in a closed pair',
                            'games', s.games, 'concentration', s.concentration,
                            'lopsided', s.lopsided,
                            'wins', jsonb_build_array(s.wins_low, s.wins_high))
    from s where s.concentration >= p_concentration and s.lopsided >= p_lopsided
  union all
  select 'rating_farming', s.low_id, s.high_id,
         jsonb_build_object('reason', 'results alternate far more than chance',
                            'games', s.games, 'concentration', s.concentration,
                            'alternation', s.alternation)
    from s where s.concentration >= p_concentration and s.alternation >= p_alternation
  union all
  select 'self_play_suspected', s.low_id, s.high_id,
         jsonb_build_object('reason', 'a closed pair finishing faster than two humans can play',
                            'games', s.games, 'concentration', s.concentration,
                            'median_seconds', s.median_seconds)
    from s where s.concentration >= p_concentration
             and s.median_seconds is not null
             and s.median_seconds < p_fast_seconds;
$$;
revoke all on function public.detect_abuse(int, numeric, numeric, numeric, numeric)
  from public, anon, authenticated;

-- --------------------------------------------------------------- the writing
-- Detection is separate from consequence on purpose: detect_abuse can be run
-- and read as often as anyone likes without touching a single account.
--
-- Findings extend the EXISTING integrity_events rather than a parallel table,
-- as the brief requires, and are deduplicated on a 24-hour window per pair per
-- kind. Without that, a scheduled run turns one collusion ring into a thousand
-- identical rows and the table stops being readable — which is the same as it
-- stopping working.
create or replace function public.apply_abuse_findings(
  p_min_games int default 5
) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  f          record;
  v_pair_key text;
  v_written  int := 0;
  v_skipped  int := 0;
  v_flagged  uuid[] := array[]::uuid[];
begin
  for f in select * from public.detect_abuse(p_min_games) loop
    v_pair_key := f.low_id::text || '|' || f.high_id::text;

    if exists (
      select 1 from public.integrity_events e
       where e.kind = f.kind
         and e.detail ->> 'pair_key' = v_pair_key
         and e.created_at > now() - interval '24 hours'
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    perform public.log_integrity_event(
      f.low_id, f.kind, 'server', null, null,
      f.detail || jsonb_build_object('pair_key', v_pair_key,
                                     'low_id', f.low_id, 'high_id', f.high_id));

    -- Both seats carry the finding. A closed pair is a two-person arrangement;
    -- flagging only the account that happened to sort first would be arbitrary.
    update public.profiles
       set trust_score = trust_score + 1,
           flags       = flags || jsonb_build_object(f.kind, true),
           updated_at  = now()
     where id in (f.low_id, f.high_id);

    v_flagged := v_flagged || f.low_id || f.high_id;
    v_written := v_written + 1;
  end loop;

  return jsonb_build_object(
    'findings_written', v_written,
    'findings_deduped', v_skipped,
    'accounts_flagged', (select count(distinct u) from unnest(v_flagged) u)
  );
end $$;
revoke all on function public.apply_abuse_findings(int) from public, anon, authenticated;
