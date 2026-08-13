-- Add stake-settlement-vs-ledger reconciliation to the money digest.
--
-- One settled stake match currently on the DB (0dca3e39) has mp_tables
-- claiming pot=20/payout=19/rake=1, but the ledger only shows one -10
-- stake_post row for seat_b and no stake_payout row for the winner. Global
-- conservation still holds (per-user ledger == balance), but the mp_tables
-- audit row overstates what was actually posted. This is stale data from a
-- pre-fix settlement RPC (see 20260811240000_mp_settle_refunds_what_was_posted).
--
-- Leaving the historical row as-is per operator decision, but adding a check
-- to the digest so any FUTURE drift between mp_tables.settlement figures and
-- the actual ledger stake rows fires an alert. Two invariants for every
-- finished stake table:
--
--   1. sum(stake_post magnitudes for this table) == pot_chips
--   2. sum(stake_payout for this table)          == payout_chips (for decided)
--   3. house_ledger sum for this table           == rake_chips
--
-- The existing row (0dca3e39) will show up as drifted going forward, which is
-- correct — the digest surfaces the anomaly rather than hiding it.

create or replace function public.owner_money_digest(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_is_owner boolean;
  v_bal_sum bigint;
  v_led_sum bigint;
  v_house_sum bigint;
  v_sig_count bigint;
  v_pay_rows bigint;
  v_unexplained bigint;
  v_events jsonb;
  v_payments jsonb;
  v_geo jsonb;
  v_ratelimit jsonb;
  v_open_intents bigint;
  v_stale_matches bigint;
  v_stake_house_bad boolean;
  v_stake_drift jsonb;
  v_stake_drift_count bigint;
begin
  select coalesce(is_owner, false) into v_is_owner
    from public.profiles where id = p_user_id;
  if not v_is_owner then
    return jsonb_build_object('error', 'forbidden');
  end if;

  select coalesce(sum(chips), 0) into v_bal_sum from public.balances;
  select coalesce(sum(delta), 0) into v_led_sum
    from public.ledger where currency = 'chips';

  select coalesce(sum(delta), 0) into v_house_sum from public.house_ledger;
  v_stake_house_bad := v_house_sum < 0;

  select count(*) into v_pay_rows from public.payments;
  select count(distinct signature) into v_sig_count from public.payments;

  select count(*) into v_unexplained
    from public.payments p
    where not exists (
      select 1 from public.ledger l
      where l.user_id = p.user_id
        and l.reason = 'chip_purchase'
        and l.match_id is null
    );

  select coalesce(jsonb_object_agg(kind, counts), '{}'::jsonb) into v_events
  from (
    select kind, jsonb_build_object(
      '24h', count(*) filter (where created_at > now() - interval '24 hours'),
      '7d',  count(*) filter (where created_at > now() - interval '7 days'),
      'all', count(*)
    ) as counts
    from public.integrity_events
    group by kind
  ) t;

  select jsonb_build_object(
    'credited_24h',  count(*) filter (where status = 'credited'  and created_at > now() - interval '24 hours'),
    'abandoned_24h', count(*) filter (where status = 'abandoned' and created_at > now() - interval '24 hours'),
    'pending_24h',   count(*) filter (where status = 'pending'   and created_at > now() - interval '24 hours'),
    'credited_7d',   count(*) filter (where status = 'credited'  and created_at > now() - interval '7 days'),
    'usdc_credited_24h',
      coalesce(sum(expected_usdc) filter (where status = 'credited' and created_at > now() - interval '24 hours'), 0)
  ) into v_payments
  from public.payment_intents;

  select count(*) into v_open_intents
    from public.payment_intents
    where status = 'pending' and created_at < now() - interval '1 hour';

  select count(*) into v_stale_matches
    from public.matches
    where status = 'in_progress' and created_at < now() - interval '2 hours';

  select coalesce(jsonb_object_agg(reason, counts), '{}'::jsonb) into v_geo
  from (
    select coalesce(detail ->> 'reason', 'unknown') as reason,
           jsonb_build_object(
             '24h', count(*) filter (where created_at > now() - interval '24 hours'),
             '7d',  count(*) filter (where created_at > now() - interval '7 days')
           ) as counts
    from public.integrity_events
    where kind = 'geo_refused'
    group by 1
  ) t;

  select coalesce(jsonb_object_agg(action, counts), '{}'::jsonb) into v_ratelimit
  from (
    select coalesce(detail ->> 'action', 'unknown') as action,
           jsonb_build_object(
             '24h', count(*) filter (where created_at > now() - interval '24 hours'),
             '7d',  count(*) filter (where created_at > now() - interval '7 days')
           ) as counts
    from public.integrity_events
    where kind = 'rate_limited'
    group by 1
  ) t;

  -- Stake-settlement drift. For every finished/settled table, compare the
  -- mp_tables claim (pot, payout, rake) against the actual ledger + house_ledger
  -- movement. A drifted row means the settlement RPC failed to write one or
  -- more of its ledger entries — the money isn't wrong (global conservation
  -- holds), but the audit trail is.
  with drift as (
    select t.id,
           t.pot_chips as claim_pot,
           t.payout_chips as claim_payout,
           t.rake_chips as claim_rake,
           coalesce(abs((
             select sum(delta) from public.ledger
             where mp_table_id = t.id and reason = 'stake_post'
           )), 0) as actual_posted,
           coalesce((
             select sum(delta) from public.ledger
             where mp_table_id = t.id and reason = 'stake_payout'
           ), 0) as actual_payout,
           coalesce((
             select sum(delta) from public.house_ledger where table_id = t.id
           ), 0) as actual_rake
      from public.mp_tables t
     where t.status in ('finished', 'settled')
        or t.settlement is not null
  )
  select
    count(*),
    coalesce(jsonb_agg(jsonb_build_object(
      'table_id', id,
      'claim_pot', claim_pot,        'actual_posted', actual_posted,
      'claim_payout', claim_payout,  'actual_payout', actual_payout,
      'claim_rake', claim_rake,      'actual_rake', actual_rake
    )) filter (where actual_posted <> claim_pot
                  or actual_payout <> claim_payout
                  or actual_rake <> claim_rake), '[]'::jsonb)
  into v_stake_drift_count, v_stake_drift
  from drift
  where actual_posted <> claim_pot
     or actual_payout <> claim_payout
     or actual_rake <> claim_rake;

  return jsonb_build_object(
    'as_of', now(),
    'conservation', jsonb_build_object(
      'balances_sum', v_bal_sum,
      'ledger_sum', v_led_sum,
      'drift', v_bal_sum - v_led_sum,
      'ok', v_bal_sum = v_led_sum
    ),
    'house', jsonb_build_object('sum', v_house_sum, 'ok', not v_stake_house_bad),
    'double_credit', jsonb_build_object(
      'payment_rows', v_pay_rows,
      'distinct_sigs', v_sig_count,
      'ok', v_pay_rows = v_sig_count
    ),
    'unexplained_credits', jsonb_build_object(
      'count', v_unexplained, 'ok', v_unexplained = 0
    ),
    'stake_settlement', jsonb_build_object(
      'drifted_count', coalesce(v_stake_drift_count, 0),
      'drifted', v_stake_drift,
      'ok', coalesce(v_stake_drift_count, 0) = 0
    ),
    'payments', v_payments,
    'stuck', jsonb_build_object(
      'pending_intents_over_1h', v_open_intents,
      'matches_in_progress_over_2h', v_stale_matches
    ),
    'integrity_events', v_events,
    'geo_refusals', v_geo,
    'rate_limits_by_action', v_ratelimit
  );
end $$;

revoke all on function public.owner_money_digest(uuid) from public, anon, authenticated;
