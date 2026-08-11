-- Two things a real user found by signing in as the treasury and pressing Buy.
--
-- 1. THE PURCHASE COULD NEVER HAVE WORKED, AND WE LET THEM TRY.
--
-- `verifyOnChain` derives the amount from the treasury's own token-balance
-- delta. When the payer IS the treasury the delta is zero — the tokens never
-- left — so verification correctly reports `no_incoming_transfer` and the
-- player sees `payment_mismatch` after signing and paying a network fee for a
-- transfer that was structurally incapable of crediting them.
--
-- This is not a rare misconfiguration to warn about, it is a provable
-- impossibility, so the intent is refused before it is issued rather than
-- explained afterwards. Refusing at `create_payment_intent` also means no
-- stale intent is created, which is the second half of what went wrong.
--
-- Checked against `profiles.wallet_address` — the value the provisioning
-- trigger copied out of the verified identity — never against anything the
-- client asserts.
--
-- 2. THE INTENT IT LEFT BEHIND WAS NOT BEING SWEPT.
--
-- `expire_stale_intents` was called only from `create_payment_intent`, i.e.
-- only when that same player next tries to buy. A player who fails once and
-- never returns leaves a pending row that stays pending forever. Harmless to
-- the UI, which filters on quote_expires_at, but "pending" then stops meaning
-- pending, and every reconcile scan carries the row for the rest of its
-- seven-day window.
--
-- The fix is to sweep on the other action every signed-in client already
-- makes: economy_state, which runs on page load. Same opportunistic pattern,
-- same reasoning as before — no cron to stop silently — but attached to the
-- event that actually happens rather than to the one that just failed.

create or replace function public.create_payment_intent(
  p_user_id       uuid,
  p_cluster       text,
  p_reference     text,
  p_expected_usdc numeric,
  p_tos_version   text,
  p_quote_minutes int default 15
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.payment_config;
  v_id uuid;
  v_wallet text;
begin
  if not public.take_rate_token(p_user_id, 'payment_intent') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  perform public.expire_stale_intents(p_user_id);

  if not exists (
    select 1 from public.tos_acceptances
     where user_id = p_user_id and version = p_tos_version
  ) then
    return jsonb_build_object('error', 'tos_required', 'version', p_tos_version);
  end if;

  select * into cfg from public.payment_config
   where cluster = p_cluster and active limit 1;
  if not found then
    return jsonb_build_object('error', 'payments_unconfigured', 'cluster', p_cluster);
  end if;

  -- The self-transfer refusal. Deliberately AFTER the config load, because the
  -- treasury address is a property of the active configuration rather than a
  -- constant, and BEFORE the intent insert, so nothing is left behind.
  select wallet_address into v_wallet from public.profiles where id = p_user_id;
  if v_wallet is not null and v_wallet = cfg.treasury_address then
    return jsonb_build_object('error', 'wallet_is_treasury');
  end if;

  if p_expected_usdc is null or p_expected_usdc <= 0 then
    return jsonb_build_object('error', 'bad_request');
  end if;

  -- Deliberately NOT exclusive. A stale intent must never block the next
  -- attempt — stranding a player behind their own abandoned tab is worse than
  -- carrying an unpaid row that costs nothing.
  insert into public.payment_intents (
    user_id, quote_expires_at, cluster, treasury_address, usdc_mint,
    usdc_decimals, chips_per_usdc, expected_usdc, reference
  ) values (
    p_user_id,
    now() + make_interval(mins => greatest(1, least(60, p_quote_minutes))),
    cfg.cluster, cfg.treasury_address, cfg.usdc_mint,
    cfg.usdc_decimals, cfg.chips_per_usdc, p_expected_usdc, p_reference
  )
  returning id into v_id;

  return jsonb_build_object(
    'intent_id',        v_id,
    'cluster',          cfg.cluster,
    'treasury_address', cfg.treasury_address,
    'usdc_mint',        cfg.usdc_mint,
    'usdc_decimals',    cfg.usdc_decimals,
    'chips_per_usdc',   cfg.chips_per_usdc,
    'expected_usdc',    p_expected_usdc,
    'reference',        p_reference,
    'quote_expires_at', now() + make_interval(mins => greatest(1, least(60, p_quote_minutes)))
  );
end $$;

revoke all on function public.create_payment_intent(uuid, text, text, numeric, text, int)
  from public, anon, authenticated;

-- ------------------------------------------------------- sweep on page load
create or replace function public.economy_state(
  p_user_id       uuid,
  p_current_theme text default null,
  p_priced        jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_xp    bigint;
  v_chips bigint;
begin
  if not public.take_rate_token(p_user_id, 'economy_state') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  -- The caller's own stale intents, on the action every signed-in client
  -- makes. Cheap: an indexed update over one player's rows, and usually zero.
  perform public.expire_stale_intents(p_user_id);

  if p_current_theme is not null
     and p_priced ? p_current_theme
     and not exists (select 1 from public.inventory where user_id = p_user_id and sku = p_current_theme)
  then
    insert into public.inventory (user_id, sku, source)
    values (p_user_id, p_current_theme, 'grant')
    on conflict do nothing;
  end if;

  insert into public.balances (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select xp, chips into v_xp, v_chips from public.balances where user_id = p_user_id;

  return jsonb_build_object(
    'xp', coalesce(v_xp, 0),
    'chips', coalesce(v_chips, 0),
    'owned', coalesce(
      (select jsonb_agg(sku order by sku) from public.inventory where user_id = p_user_id),
      '[]'::jsonb
    )
  );
end $$;

revoke all on function public.economy_state(uuid, text, jsonb) from public, anon, authenticated;

-- Clear the one this bug left behind, and anything else already past its quote.
select public.expire_stale_intents();
