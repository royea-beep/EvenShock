-- Pending intents never stopped being pending.
--
-- Three were sitting in production from the payment suite: the theft-test
-- intent, the wrong-recipient one, and the no-reference one. All three are
-- CORRECT outcomes — no valid payment was ever made against them, so nothing
-- will ever credit them, and they sit pending forever. Harmless in the database
-- and not harmless in the UI, where an open intent is what makes the purchase
-- screen offer to resume a payment that is never going to arrive.
--
-- THE ORDER OF THE TWO CHANGES BELOW IS THE WHOLE POINT.
--
-- The schema's promise is that expiry is presentation only: "a payment that
-- confirms an hour late still credits". Reconciliation is what keeps that
-- promise for the player who paid and closed the tab — and it scanned
-- `status = 'pending'`. So sweeping intents to 'abandoned' while reconcile
-- still looked only at pending would have quietly converted the promise into
-- stranded money: the sweep would hide exactly the intents reconciliation
-- exists to rescue, and nobody would notice until someone paid late.
--
-- So reconcile's scan is widened FIRST, and only then does anything get swept.

-- ------------------------------------------------- 1. widen what gets scanned
--
-- Any intent that has not been credited is still a candidate, whatever the UI
-- has decided to call it. 'abandoned' now means "the screen stopped waiting",
-- never "the money is forfeit" — and `loadIntent` filters on id and owner
-- only, so `confirm_payment` credits an abandoned intent just the same.
drop function if exists public.open_intents_for_reconcile(interval);

create function public.open_intents_for_reconcile(p_max_age interval default '7 days')
returns table (id uuid, user_id uuid, cluster text, reference text,
               treasury_address text, usdc_mint text, usdc_decimals int,
               chips_per_usdc int)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.user_id, i.cluster, i.reference,
         i.treasury_address, i.usdc_mint, i.usdc_decimals, i.chips_per_usdc
    from public.payment_intents i
   where i.status <> 'credited'
     and i.created_at > now() - p_max_age
   order by i.created_at;
$$;

revoke all on function public.open_intents_for_reconcile(interval) from public, anon, authenticated;

-- ------------------------------------------------------- 2. and now the sweep
create or replace function public.expire_stale_intents(p_user_id uuid default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update public.payment_intents
     set status = 'abandoned'
   where status = 'pending'
     and quote_expires_at < now()
     and (p_user_id is null or user_id = p_user_id);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.expire_stale_intents(uuid) from public, anon, authenticated;

-- Called for the caller's OWN intents when they open a new one, so by the time
-- someone presses Buy their stale rows are already cleared and no resume prompt
-- appears for a payment that was never made.
--
-- No cron. The same reasoning that made `reconcile` a button rather than a
-- schedule applies here: nothing in this project is scheduled yet, and a
-- sweeper that silently stops is worse than one that runs when it is needed.
-- This runs at exactly the moment its result is about to be looked at.
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
begin
  if not public.take_rate_token(p_user_id, 'payment_intent') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  -- Before anything else, and only ever this caller's own rows.
  perform public.expire_stale_intents(p_user_id);

  -- Blocking, not advisory: no intent is issued to someone who has not
  -- acknowledged that chips have no cash value.
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

-- Clear the three left behind by the suite that prompted this.
select public.expire_stale_intents();
