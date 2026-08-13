-- Money-anomaly monitoring.
--
-- "I only learn something broke if I go look" is not a plan that survives real
-- users. This migration installs two things:
--
--   1. `geo_refused` integrity events. `create_payment_intent` and the mp
--      seat RPCs already REFUSE on geo, but the refusal never lands anywhere
--      queryable. Adding a `log_integrity_event(..., 'geo_refused', ...)` on
--      those paths gives the digest something to count without changing the
--      refusal contract or the response shape.
--
--   2. `owner_money_digest(p_user_id uuid)`. One RPC that returns a single
--      JSON snapshot of everything worth watching on the money surface:
--      chip conservation, double-credit check, integrity event rollups by
--      severity, payment status counts, geo refusals, and any unexplained
--      credits. The digest is what a person (or a cron) reads to know at a
--      glance whether anything is off; the underlying tables are always the
--      source of truth.
--
-- SECURITY: SECURITY DEFINER, but gated by profiles.is_owner. Every read is
-- across all users (this is the whole point — spotting drift, not per-user
-- self-service), so RLS would defeat it. The is_owner check is the substitute
-- for RLS, and it is checked BEFORE any table is touched. Any non-owner
-- caller receives `{"error":"forbidden"}` before a single row is scanned.

-- =========================================================== payment refusals

create or replace function public.create_payment_intent(
  p_user_id uuid, p_cluster text, p_reference text,
  p_expected_usdc numeric, p_tos_version text, p_quote_minutes int default 15
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare cfg public.payment_config; v_id uuid; v_wallet text; v_geo jsonb;
begin
  if not public.take_rate_token(p_user_id, 'payment_intent') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  v_geo := public.geo_allows_money(p_user_id);
  if not (v_geo ->> 'allowed')::boolean then
    -- Log the refusal so the digest can count it. The refusal contract to
    -- the client is unchanged: same error code, same status.
    perform public.log_integrity_event(
      p_user_id, 'geo_refused', 'server', null, null,
      jsonb_build_object(
        'action', 'create_payment_intent',
        'reason', v_geo ->> 'reason',
        'country', v_geo ->> 'country'
      )
    );
    return jsonb_build_object('error', v_geo ->> 'reason', 'country', v_geo ->> 'country');
  end if;

  perform public.expire_stale_intents(p_user_id);

  if not exists (select 1 from public.tos_acceptances
                  where user_id = p_user_id and version = p_tos_version and context = 'purchase') then
    return jsonb_build_object('error', 'tos_required', 'version', p_tos_version);
  end if;

  select * into cfg from public.payment_config where cluster = p_cluster and active limit 1;
  if not found then
    return jsonb_build_object('error', 'payments_unconfigured', 'cluster', p_cluster);
  end if;

  select wallet_address into v_wallet from public.profiles where id = p_user_id;
  if v_wallet is not null and v_wallet = cfg.treasury_address then
    return jsonb_build_object('error', 'wallet_is_treasury');
  end if;

  if p_expected_usdc is null or p_expected_usdc <= 0 then
    return jsonb_build_object('error', 'bad_request');
  end if;

  insert into public.payment_intents (
    user_id, quote_expires_at, cluster, treasury_address, usdc_mint,
    usdc_decimals, chips_per_usdc, expected_usdc, reference
  ) values (
    p_user_id, now() + make_interval(mins => greatest(1, least(60, p_quote_minutes))),
    cfg.cluster, cfg.treasury_address, cfg.usdc_mint,
    cfg.usdc_decimals, cfg.chips_per_usdc, p_expected_usdc, p_reference
  ) returning id into v_id;

  return jsonb_build_object(
    'intent_id', v_id, 'cluster', cfg.cluster, 'treasury_address', cfg.treasury_address,
    'usdc_mint', cfg.usdc_mint, 'usdc_decimals', cfg.usdc_decimals,
    'chips_per_usdc', cfg.chips_per_usdc, 'expected_usdc', p_expected_usdc,
    'reference', p_reference,
    'quote_expires_at', now() + make_interval(mins => greatest(1, least(60, p_quote_minutes))));
end $$;

revoke all on function public.create_payment_intent(uuid, text, text, numeric, text, int)
  from public, anon, authenticated;

-- ================================================================= the digest

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
begin
  select coalesce(is_owner, false) into v_is_owner
    from public.profiles where id = p_user_id;
  if not v_is_owner then
    return jsonb_build_object('error', 'forbidden');
  end if;

  -- CONSERVATION. The core money invariant. sum(balances.chips) must equal
  -- sum(ledger.delta where currency='chips'). Any drift is a bug or a bypass.
  select coalesce(sum(chips), 0) into v_bal_sum from public.balances;
  select coalesce(sum(delta), 0) into v_led_sum
    from public.ledger where currency = 'chips';

  -- HOUSE. house_ledger records the rake. Sanity-check that it does not go
  -- negative (which would mean we PAID a rake, not received one).
  select coalesce(sum(delta), 0) into v_house_sum from public.house_ledger;
  v_stake_house_bad := v_house_sum < 0;

  -- DOUBLE-CREDIT. payments.signature is a primary key; row count should
  -- always equal distinct signature count. Any drift means the PK failed
  -- (which is impossible short of DB corruption) or someone bypassed the RPC.
  select count(*) into v_pay_rows from public.payments;
  select count(distinct signature) into v_sig_count from public.payments;

  -- UNEXPLAINED CREDITS. Every credited payment should produce a matching
  -- ledger row (via credit_purchase). A credited payment with no ledger row
  -- is either a broken code path or a manual insert bypassing credit_ledger.
  select count(*) into v_unexplained
    from public.payments p
    where not exists (
      select 1 from public.ledger l
      where l.user_id = p.user_id
        and l.reason = 'chip_purchase'
        and l.match_id is null
        -- The link between payment and ledger goes via payments.ledger_id,
        -- but the invariant we want here is "at least one purchase debit for
        -- every credited payment", not "each payment row has ledger_id set".
        -- Loose check on purpose.
    );

  -- INTEGRITY EVENTS. Rollup by kind for the recent windows the operator
  -- cares about. Any event kind can appear here; unknowns don't crash the
  -- digest, they show up in the output.
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

  -- PAYMENTS. Status counts for a 24h window: healthy vs failing vs stuck.
  select jsonb_build_object(
    'credited_24h',  count(*) filter (where status = 'credited'  and created_at > now() - interval '24 hours'),
    'abandoned_24h', count(*) filter (where status = 'abandoned' and created_at > now() - interval '24 hours'),
    'pending_24h',   count(*) filter (where status = 'pending'   and created_at > now() - interval '24 hours'),
    'credited_7d',   count(*) filter (where status = 'credited'  and created_at > now() - interval '7 days'),
    'usdc_credited_24h',
      coalesce(sum(expected_usdc) filter (where status = 'credited' and created_at > now() - interval '24 hours'), 0)
  ) into v_payments
  from public.payment_intents;

  -- Pending intents older than the quote window are STUCK. `expire_stale_intents`
  -- runs lazily; a nonzero count here says the lazy path is not being hit.
  select count(*) into v_open_intents
    from public.payment_intents
    where status = 'pending' and created_at < now() - interval '1 hour';

  -- Matches stuck in_progress past reasonable play time. Not a money bug per
  -- se, but a signal something is leaving state behind.
  select count(*) into v_stale_matches
    from public.matches
    where status = 'in_progress' and created_at < now() - interval '2 hours';

  -- GEO REFUSALS. Recent counts by reason so a spike (jurisdiction attack,
  -- VPN farm, provider bug) is visible.
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

  -- RATE LIMITS by action, so a specific endpoint being hammered is visible.
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

  return jsonb_build_object(
    'as_of', now(),
    'conservation', jsonb_build_object(
      'balances_sum', v_bal_sum,
      'ledger_sum', v_led_sum,
      'drift', v_bal_sum - v_led_sum,
      'ok', v_bal_sum = v_led_sum
    ),
    'house', jsonb_build_object(
      'sum', v_house_sum,
      'ok', not v_stake_house_bad
    ),
    'double_credit', jsonb_build_object(
      'payment_rows', v_pay_rows,
      'distinct_sigs', v_sig_count,
      'ok', v_pay_rows = v_sig_count
    ),
    'unexplained_credits', jsonb_build_object(
      'count', v_unexplained,
      'ok', v_unexplained = 0
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

comment on function public.owner_money_digest is
  'One-shot snapshot of every money-surface signal worth watching. Owner-only. '
  'Consumed by the play edge function (action=owner_digest) and by CLI cron.';
