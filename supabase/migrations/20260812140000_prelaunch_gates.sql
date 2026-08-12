-- Pre-launch gates: age/ToS at the money surface, geo, and two rate limits
-- that were defined but never taken.
--
-- WHAT IS ACTUALLY A MONEY SURFACE TODAY. Stake tables are off behind
-- feature_flags, so the single reachable action that moves real value is
-- `create_payment_intent` — buying chips. Everything below gates that first and
-- gates the stake path in the same breath, so turning stakes on later does not
-- also mean remembering to gate them.

-- ======================================================= 1. age and terms
--
-- The existing tos_acceptances table already records version + timestamp per
-- user and create_payment_intent already refuses without one. Two things were
-- missing: the acceptance did not distinguish WHAT was accepted, and the terms
-- did not carry the 18+ claim or the no-cash-value claim as separate,
-- acknowledged statements.
--
-- `context` rather than a second table: the mechanism is proven and the
-- question "which text did they agree to, and for what" is answerable from one
-- row rather than a join.
alter table public.tos_acceptances
  add column if not exists context text not null default 'purchase';

alter table public.tos_acceptances drop constraint if exists tos_acceptances_context_check;
alter table public.tos_acceptances add constraint tos_acceptances_context_check
  check (context in ('purchase', 'stake'));

comment on column public.tos_acceptances.context is
  'What was being agreed to: buying chips, or sitting at a stake table. Different acts, separately evidenced.';

-- The claims themselves, as data. A version bump re-triggers the gate, and the
-- text that was in force at any past moment stays readable — which is the
-- entire point of recording a version rather than a boolean.
create table if not exists public.tos_versions (
  version      text primary key,
  effective_at timestamptz not null default now(),
  age_minimum  int not null default 18,
  -- The load-bearing claim of the whole legal posture, stored rather than
  -- rendered from a constant in a component, so it can be produced later
  -- exactly as it was shown.
  claims       jsonb not null,
  active       boolean not null default true
);

alter table public.tos_versions enable row level security;
revoke all on public.tos_versions from anon, authenticated;
create policy tos_versions_read on public.tos_versions for select to authenticated using (active);
grant select on public.tos_versions to authenticated;

insert into public.tos_versions (version, age_minimum, claims) values
  ('v2', 18, jsonb_build_array(
    jsonb_build_object('key', 'age',
      'text', 'I am 18 or older.'),
    jsonb_build_object('key', 'no_cash_value',
      'text', 'Chips have no cash value. They cannot be withdrawn, cannot be converted to money, cannot be exchanged for goods, and are only spent inside the game.'),
    jsonb_build_object('key', 'no_refund_as_money',
      'text', 'Money paid for chips is not returned as money. Chips in, never out.')
  ))
on conflict (version) do nothing;

-- ================================================= 2. geo, config not code
create table if not exists public.geo_blocklist (
  country_code text primary key,
  reason       text not null,
  -- 'stakes' gates the money surfaces only; 'all' gates the whole product.
  -- The column exists so counsel can escalate a country without a schema
  -- change and without a deploy.
  blocks       text not null default 'stakes' check (blocks in ('stakes', 'all')),
  added_at     timestamptz not null default now(),
  active       boolean not null default true
);

alter table public.geo_blocklist enable row level security;
revoke all on public.geo_blocklist from anon, authenticated;

insert into public.geo_blocklist (country_code, reason, blocks) values
  ('IL', 'Pending counsel review of real-money play under Israeli law.', 'stakes'),
  ('US', 'Pending counsel review; state-by-state exposure means the whole country is blocked until the analysis is done.', 'stakes')
on conflict (country_code) do nothing;

-- The verdict, stored rather than re-derived.
--
-- "Why was this account allowed to pay on the 4th?" is answerable from a row
-- recording the country, the source, and the blocklist version in force at
-- that moment. Re-deriving it against today's list answers a different
-- question.
create table if not exists public.geo_verdicts (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  country_code text,                      -- null = could not resolve
  source       text not null,             -- which resolver said so
  is_datacenter boolean not null default false,
  allowed      boolean not null,
  list_version timestamptz,               -- max(added_at) at decision time
  decided_at   timestamptz not null default now()
);

alter table public.geo_verdicts enable row level security;
revoke all on public.geo_verdicts from anon, authenticated;

comment on table public.geo_verdicts is
  'One row per user: the last country decision and what it was based on. Auditable rather than recomputed — the blocklist changes, and a past decision must stay explainable.';

/**
 * The gate. FAILS CLOSED.
 *
 * `unknown` and `blocked` produce the same answer at a money surface and
 * different copy, because the asymmetry decides it: failing open means someone
 * in a blocked jurisdiction commits an offence, failing closed means a
 * legitimate player cannot buy chips until the lookup succeeds — and can still
 * play the bot game, free tables and the shop.
 *
 * A datacenter address is treated as unresolved rather than as its apparent
 * country. Commercial VPN egress is overwhelmingly datacenter-hosted, so this
 * converts the most common evasion into the fail-closed branch without
 * pretending to know where the user really is.
 *
 * IT IS A COMPLIANCE SIGNAL, NOT A SECURITY CONTROL. A VPN defeats it. This
 * demonstrates reasonable steps; it does not claim to stop a determined person.
 */
create or replace function public.geo_allows_money(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v public.geo_verdicts; v_block public.geo_blocklist;
begin
  select * into v from public.geo_verdicts where user_id = p_user_id;

  if not found or v.country_code is null or v.is_datacenter then
    return jsonb_build_object('allowed', false, 'reason', 'geo_unknown');
  end if;

  select * into v_block from public.geo_blocklist
   where country_code = v.country_code and active;
  if found then
    return jsonb_build_object('allowed', false, 'reason', 'geo_blocked',
                              'country', v.country_code);
  end if;

  return jsonb_build_object('allowed', true, 'country', v.country_code);
end $$;
revoke all on function public.geo_allows_money(uuid) from public, anon, authenticated;

/** Records a resolver's answer and decides it in the same transaction, so the
 *  stored verdict and the list it was judged against cannot drift apart. */
create or replace function public.geo_record_verdict(
  p_user_id uuid, p_country text, p_source text, p_is_datacenter boolean default false
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_allowed boolean; v_list timestamptz;
begin
  select max(added_at) into v_list from public.geo_blocklist where active;

  v_allowed := p_country is not null
           and not p_is_datacenter
           and not exists (select 1 from public.geo_blocklist
                            where country_code = p_country and active);

  insert into public.geo_verdicts (user_id, country_code, source, is_datacenter, allowed, list_version)
  values (p_user_id, p_country, p_source, coalesce(p_is_datacenter, false), v_allowed, v_list)
  on conflict (user_id) do update
    set country_code = excluded.country_code,
        source = excluded.source,
        is_datacenter = excluded.is_datacenter,
        allowed = excluded.allowed,
        list_version = excluded.list_version,
        decided_at = now();

  return jsonb_build_object('ok', true, 'allowed', v_allowed, 'country', p_country);
end $$;
revoke all on function public.geo_record_verdict(uuid, text, text, boolean) from public, anon, authenticated;

-- ==================================== 3. the gates on the money surfaces
--
-- create_payment_intent is the only reachable money action while stakes are
-- off. mp_create_table is gated in the same migration so that turning stakes on
-- does not also mean remembering this.
create or replace function public.create_payment_intent(
  p_user_id       uuid,
  p_cluster       text,
  p_reference     text,
  p_expected_usdc numeric,
  p_tos_version   text,
  p_quote_minutes int default 15
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  cfg public.payment_config;
  v_id uuid;
  v_wallet text;
  v_geo jsonb;
begin
  if not public.take_rate_token(p_user_id, 'payment_intent') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  -- Jurisdiction before anything is issued. Fails closed: an unresolved
  -- location does not get to buy.
  v_geo := public.geo_allows_money(p_user_id);
  if not (v_geo ->> 'allowed')::boolean then
    return jsonb_build_object('error', v_geo ->> 'reason', 'country', v_geo ->> 'country');
  end if;

  perform public.expire_stale_intents(p_user_id);

  if not exists (
    select 1 from public.tos_acceptances
     where user_id = p_user_id and version = p_tos_version and context = 'purchase'
  ) then
    return jsonb_build_object('error', 'tos_required', 'version', p_tos_version);
  end if;

  select * into cfg from public.payment_config
   where cluster = p_cluster and active limit 1;
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

-- ============================ 4. the two unused rate-limit buckets
--
-- `confirm_payment` has a bucket in take_rate_token that nothing calls, and
-- `record_tos_acceptance` has neither bucket nor call. Only one of them should
-- be closed here, and the reason is worth stating rather than mechanically
-- ticking both.
--
-- confirm_payment: NOT closed in the database, deliberately. The only
-- database-side place to put it is `credit_purchase` — which runs AFTER the
-- transaction has been verified on chain. A throttle there would refuse to
-- credit money that has already, irreversibly, been paid. The limit belongs at
-- the Edge Function's entry to the confirm action, before verification, where
-- refusing costs the player nothing but a retry. Recorded as an open item
-- rather than closed wrongly.
--
-- record_tos_acceptance: closed. It writes a row per call with no ceiling, and
-- refusing one costs a player a retry.
create or replace function public.record_tos_acceptance(p_user_id uuid, p_version text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if not public.take_rate_token(p_user_id, 'accept_tos') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  insert into public.tos_acceptances (user_id, version, context)
  values (p_user_id, p_version, 'purchase')
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'version', p_version, 'context', 'purchase');
end $$;
revoke all on function public.record_tos_acceptance(uuid, text) from public, anon, authenticated;
