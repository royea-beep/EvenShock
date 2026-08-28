-- Swap-routed purchases: what the quote is bound to.
--
-- A USDC-direct intent freezes recipient, mint and decimals. A swap adds a
-- rate that expires, so the intent additionally records what was quoted — the
-- input token, the amounts, the guaranteed minimum, the mode, and a route
-- fingerprint — making a dispute answerable from our own rows rather than
-- from Jupiter's.
--
-- All columns are nullable and NULL means "USDC-direct intent"; the existing
-- path writes none of them and reads none of them.
--
-- CRITICAL NON-GOAL, stated so nobody adds it later: quote expiry is
-- presentation-only, exactly like quote_expires_at has always been. The
-- client refuses to SIGN after expiry; the server never refuses to CREDIT
-- after expiry. The enforcement that matters is on-chain (the route's
-- minimum-out), and a swap that lands late still credits the treasury's
-- actual USDC delta at the intent's frozen rate. A server-side "refuse credit
-- after quote expiry" would strand money a player has irreversibly paid.
alter table public.payment_intents
  add column input_mint            text,
  add column input_symbol          text,
  add column input_decimals        int,
  add column swap_mode             text check (swap_mode in ('ExactIn', 'ExactOut')),
  add column quoted_input_amount   numeric,
  add column quoted_usdc_out       numeric,
  add column min_usdc_out          numeric,
  add column slippage_bps          int,
  add column swap_quote_expires_at timestamptz,
  add column quote_route           jsonb;

comment on column public.payment_intents.swap_quote_expires_at is
  'Client-side signing deadline for the recorded quote. Presentation-only: never gates crediting.';
comment on column public.payment_intents.quote_route is
  'Route fingerprint (labels, venue keys, amounts) — not the raw aggregator response.';

-- Records a quote onto an intent the caller owns. Called by the Edge Function
-- only (service role), like every other money write. Re-quoting is on the
-- SAME intent: one reference per purchase attempt keeps reconciliation exact
-- (whichever quote's transaction lands, the reference scan finds it), and
-- refreshing a 60-second quote must not burn the 10/min intent budget.
--
-- Safe because the columns verification uses — treasury_address, usdc_mint,
-- usdc_decimals, chips_per_usdc, reference — are never touched here. Quote
-- columns are presentation and audit; credit_purchase and verifyOnChain never
-- read them.
create or replace function public.record_swap_quote(
  p_user_id        uuid,
  p_intent_id      uuid,
  p_input_mint     text,
  p_swap_mode      text,
  p_quoted_input   numeric,
  p_quoted_usdc_out numeric,
  p_min_usdc_out   numeric,
  p_slippage_bps   int,
  p_route          jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  it  public.payment_intents;
  tok public.accepted_input_tokens;
  v_expires timestamptz;
begin
  select * into it from public.payment_intents where id = p_intent_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if it.user_id <> p_user_id then return jsonb_build_object('error', 'not_found'); end if;
  if it.status <> 'pending' then return jsonb_build_object('error', 'intent_not_open'); end if;

  -- The mint must be on the allow-list for the intent's cluster, active, and
  -- must not be the settlement mint itself — "swap USDC to USDC" is the
  -- direct path wearing a costume.
  select * into tok from public.accepted_input_tokens
   where mint = p_input_mint and cluster = it.cluster and active;
  if not found or p_input_mint = it.usdc_mint then
    return jsonb_build_object('error', 'unsupported_input_mint');
  end if;

  if p_swap_mode not in ('ExactIn', 'ExactOut')
     or p_quoted_input is null or p_quoted_input <= 0
     or p_quoted_usdc_out is null or p_quoted_usdc_out <= 0
     or p_min_usdc_out is null or p_min_usdc_out <= 0
     or p_min_usdc_out > p_quoted_usdc_out
     or p_slippage_bps is null or p_slippage_bps < 0 or p_slippage_bps > 1000 then
    return jsonb_build_object('error', 'bad_request');
  end if;

  -- Refuse a quote whose GUARANTEED minimum is below one chip. Without this,
  -- "at least 0 chips" would be an honest display of an absurd purchase, and
  -- real money could land as a below_one_chip dust row by design.
  if floor(p_min_usdc_out * it.chips_per_usdc) < 1 then
    return jsonb_build_object('error', 'quote_too_small');
  end if;

  v_expires := now() + interval '60 seconds';

  update public.payment_intents set
    input_mint            = tok.mint,
    input_symbol          = tok.symbol,
    input_decimals        = tok.decimals,
    swap_mode             = p_swap_mode,
    quoted_input_amount   = p_quoted_input,
    quoted_usdc_out       = p_quoted_usdc_out,
    min_usdc_out          = p_min_usdc_out,
    slippage_bps          = p_slippage_bps,
    swap_quote_expires_at = v_expires,
    quote_route           = p_route
  where id = p_intent_id;

  return jsonb_build_object(
    'ok', true,
    'intent_id', p_intent_id,
    'input_mint', tok.mint,
    'input_symbol', tok.symbol,
    'input_decimals', tok.decimals,
    'swap_mode', p_swap_mode,
    'quoted_input_amount', p_quoted_input,
    'quoted_usdc_out', p_quoted_usdc_out,
    'min_usdc_out', p_min_usdc_out,
    'min_chips', floor(p_min_usdc_out * it.chips_per_usdc)::bigint,
    'chips_per_usdc', it.chips_per_usdc,
    'slippage_bps', p_slippage_bps,
    'swap_quote_expires_at', v_expires
  );
end $$;

revoke all on function public.record_swap_quote(uuid, uuid, text, text, numeric, numeric, numeric, int, jsonb)
  from public, anon, authenticated;
