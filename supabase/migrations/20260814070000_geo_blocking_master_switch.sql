-- Geo-blocking becomes a master switch, not an owner exception.
--
-- The problem it solves is mundane — testing the purchase path from a country
-- the blocklist refuses — but the shape matters more than the convenience,
-- because this is a compliance control and the compliance story assumes it was
-- on. Four properties follow from that:
--
--   1. DEFAULT ON. The row this migration inserts is `enabled = true`, so a
--      fresh environment is blocked-by-default and only a deliberate operator
--      action turns it off. A geo control that ships defaulting to permissive
--      is the wrong shape even when today's intended value is off — the
--      default is what a restored backup, a new branch, or a second project
--      inherits.
--
--   2. ENFORCED IN THE DATABASE, in `geo_allows_money`, where the check
--      already lives. Not in the Edge Function and not in the UI: same posture
--      as the treasury guard, the stake-tables gate and the rate limiter. A
--      control the client could route around is a control in name only.
--
--   3. "ALLOWED" IS NEVER AMBIGUOUS. Every return path now carries a `reason`.
--      Previously an allow was `{allowed: true, country: 'IL'}` with no reason
--      at all, so "we checked and you are permitted" and "we did not check"
--      would have been indistinguishable to any future reader. They are now
--      `geo_allowed` and `geo_disabled`.
--
--   4. THE BYPASS IS RECORDED. Every payment intent that only got through
--      because the switch was off writes a `geo_bypassed` integrity event. The
--      question after turning it back on is "what got through while it was
--      off", and that has to be answerable from rows rather than from memory.
--
-- WHAT DOES NOT CHANGE, deliberately:
--
--   THE BLOCKLIST STAYS DATA. `geo_blocklist` is untouched — no country moves
--   into code, nothing is hard-coded here.
--
--   FAIL-CLOSED SURVIVES. With the switch ON the behaviour is byte-for-byte
--   what it was: a missing verdict, a null country or a datacenter IP all
--   still refuse with `geo_unknown`. The switch does not soften the check; it
--   either runs it or does not.

-- ORDERING NOTE: the audit table and trigger are created BEFORE the flag row is
-- inserted, so the flag's own creation leaves an audit row too. The first
-- version of this file had it the other way round and the trail began at the
-- first flip — which is precisely the gap the audit exists to close, since
-- "it shipped ON" is the claim it has to support. Fixed for fresh
-- environments; 20260814071000 backfills the ones that ran the original order.

-- ---------------------------------------------------------------- the audit
-- A geo control that can be toggled silently is worse than no geo control,
-- because the compliance story assumes it was on and nothing contradicts that
-- assumption. This makes every flip leave a row.
--
-- A TRIGGER RATHER THAN A SETTER FUNCTION, for the same reason the Nemesis
-- trophy became a trigger: a setter can be bypassed by anyone who writes the
-- obvious UPDATE, and the obvious UPDATE is exactly what a hurried operator
-- reaches for. This cannot be gone around without disabling the trigger, which
-- is itself a deliberate and visible act.
create table if not exists public.feature_flag_audit (
  id           bigint generated always as identity primary key,
  key          text        not null,
  old_enabled  boolean,
  new_enabled  boolean     not null,
  reason       text,
  -- WHO, as precisely as this database can honestly answer. `auth.uid()` is
  -- the signed-in user and is NULL for a service-role or SQL-editor change;
  -- `current_user` says which role made it. Recording both is the honest
  -- version — one of them is always null-ish, and pretending otherwise would
  -- put a confident wrong name in an audit trail.
  changed_by   uuid,
  changed_role text        not null,
  changed_at   timestamptz not null default now()
);
alter table public.feature_flag_audit enable row level security;
revoke all on public.feature_flag_audit from anon, authenticated;
create index if not exists feature_flag_audit_key_time
  on public.feature_flag_audit (key, changed_at desc);

comment on table public.feature_flag_audit is
  'Every change to feature_flags, including the geo_blocking master switch. '
  'Append-only by intent: the compliance question is not "is it on now" but '
  '"was it on then", and only history answers that.';

create or replace function public.feature_flag_audited()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  -- A no-op UPDATE is not a change and should not pad the trail.
  if tg_op = 'UPDATE' and new.enabled is not distinct from old.enabled
     and new.reason is not distinct from old.reason then
    return new;
  end if;

  insert into public.feature_flag_audit (
    key, old_enabled, new_enabled, reason, changed_by, changed_role
  ) values (
    new.key,
    case when tg_op = 'UPDATE' then old.enabled end,
    new.enabled,
    new.reason,
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
    current_user
  );

  new.changed_at := now();
  return new;
end $$;

drop trigger if exists feature_flags_audited on public.feature_flags;
create trigger feature_flags_audited
  before insert or update on public.feature_flags
  for each row execute function public.feature_flag_audited();

-- --------------------------------------------------------------- the switch
-- Same table and same pattern as stake_tables. Inserted ON. `on conflict do
-- nothing` so re-running the migration — or applying it to an environment
-- where an operator has already made a choice — never silently re-flips it.
insert into public.feature_flags (key, enabled, reason) values (
  'geo_blocking',
  true,
  'Master switch for the geographic money gate. ON means geo_allows_money '
  'enforces the blocklist and fails closed on unknown or datacenter IPs. OFF '
  'means the check does not run at all and every purchase is permitted — a '
  'testing posture only, recorded per purchase as a geo_bypassed integrity '
  'event. MUST be ON for mainnet; see docs/mainnet-activation-checklist.md.'
) on conflict (key) do nothing;

-- ------------------------------------------------------------- the reader
-- FAIL-SAFE DIRECTION: a missing row reads as ON. Deleting the flag row must
-- not be a way to disable the control, and a restored-but-incomplete database
-- should refuse money rather than take it.
create or replace function public.geo_blocking_enabled()
returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce(
    (select enabled from public.feature_flags where key = 'geo_blocking'),
    true);
$$;
revoke all on function public.geo_blocking_enabled() from public, anon, authenticated;

-- ------------------------------------------------------------ the gate
create or replace function public.geo_allows_money(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to '' as $function$
declare v public.geo_verdicts; v_block public.geo_blocklist;
begin
  -- Read the verdict first even when the switch is off, so the bypass record
  -- carries whatever country we did know. An audit entry that says "allowed,
  -- check disabled, country unknown" is weaker than one that names the
  -- country, and the lookup costs the same either way.
  select * into v from public.geo_verdicts where user_id = p_user_id;

  if not public.geo_blocking_enabled() then
    return jsonb_build_object(
      'allowed', true, 'reason', 'geo_disabled', 'country', v.country_code);
  end if;

  -- FAIL CLOSED. Unchanged from before the switch existed: no verdict, no
  -- country, or a datacenter IP all refuse.
  if v.user_id is null or v.country_code is null or v.is_datacenter then
    return jsonb_build_object('allowed', false, 'reason', 'geo_unknown');
  end if;

  select * into v_block from public.geo_blocklist
   where country_code = v.country_code and active;
  if found then
    return jsonb_build_object(
      'allowed', false, 'reason', 'geo_blocked', 'country', v.country_code);
  end if;

  -- Explicitly reasoned, so an allow can never be confused with a skip.
  return jsonb_build_object(
    'allowed', true, 'reason', 'geo_allowed', 'country', v.country_code);
end $function$;

-- ------------------------------------------------- record what got through
-- Only the geo branch changes. Everything else in this function is carried
-- over byte-for-byte; it is re-emitted in full because plpgsql has no way to
-- patch a body.
create or replace function public.create_payment_intent(
  p_user_id uuid, p_cluster text, p_reference text, p_expected_usdc numeric,
  p_tos_version text, p_quote_minutes integer default 15)
returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare cfg public.payment_config; v_id uuid; v_wallet text; v_geo jsonb;
begin
  if not public.take_rate_token(p_user_id, 'payment_intent') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  v_geo := public.geo_allows_money(p_user_id);
  if not (v_geo ->> 'allowed')::boolean then
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

  -- THE BYPASS LEDGER. This intent is only being created because the master
  -- switch is off; with it on, this same call might well have been refused.
  -- Recorded per intent so "what got through while it was off" is a query
  -- rather than a reconstruction.
  if v_geo ->> 'reason' = 'geo_disabled' then
    perform public.log_integrity_event(
      p_user_id, 'geo_bypassed', 'server', null, null,
      jsonb_build_object(
        'action', 'create_payment_intent',
        'country', v_geo ->> 'country',
        'expected_usdc', p_expected_usdc,
        'cluster', p_cluster,
        'note', 'geo_blocking feature flag was OFF; no geographic check ran'
      )
    );
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
end $function$;
