-- Buying chips with USDC. Devnet first; nothing here is mainnet-specific.
--
-- The rule this schema exists to enforce: WE NEVER TRUST THE CLIENT'S CLAIM
-- THAT IT PAID. The client reports a transaction signature and nothing else.
-- Everything that decides whether chips are credited — recipient, mint, amount,
-- confirmation, and above all "has this signature already been credited" —
-- comes from the chain, checked by the server, and recorded here.
--
-- The anti-replay guarantee is a PRIMARY KEY, not a code path: `payments`
-- is keyed on the signature, so one transaction can be credited exactly once,
-- ever, enforced by the database. Without that, one real $1 transfer replayed a
-- hundred times is 10,000 chips.

-- ============================================================ configuration
--
-- Rows, not constants, so rotating the treasury is an insert rather than a
-- deploy. Crucially this table is NOT what verification compares against —
-- see payment_intents. It only supplies the values a NEW intent freezes.
create table public.payment_config (
  id               bigint generated always as identity primary key,
  cluster          text not null check (cluster in ('devnet', 'mainnet-beta')),
  treasury_address text not null,
  usdc_mint        text not null,
  usdc_decimals    int  not null default 6,
  -- The RATE is the invariant, not the product. A mispayment is then
  -- arithmetic rather than a support ticket: underpay and get fewer chips,
  -- overpay and get more, at the same rate either way.
  chips_per_usdc   int  not null check (chips_per_usdc > 0),
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  retired_at       timestamptz
);

-- One live configuration per cluster. Retiring is `active = false`, which keeps
-- the old row readable for intents that quoted it.
create unique index payment_config_active_per_cluster
  on public.payment_config (cluster) where active;

comment on table public.payment_config is
  'Supplies values to NEW intents. Verification uses the intent''s frozen copy, never this — which is what makes rotation safe with no cutover window.';

-- ================================================================= intents
create table public.payment_intents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  -- PRESENTATION ONLY. Past this the UI stops polling and stops calling the
  -- payment in progress. It does NOT forfeit anything: the money is real and
  -- irreversible, so verification never checks expiry. A payment that confirms
  -- an hour late still credits.
  quote_expires_at timestamptz not null,

  -- Frozen at creation. Verification compares the transaction against THESE,
  -- so a treasury rotation cannot strip an in-flight payment of its recipient.
  cluster          text not null check (cluster in ('devnet', 'mainnet-beta')),
  treasury_address text not null,
  usdc_mint        text not null,
  usdc_decimals    int  not null,
  chips_per_usdc   int  not null,
  expected_usdc    numeric(20, 6) not null check (expected_usdc > 0),

  -- Solana Pay style reference: a unique pubkey included as a read-only account
  -- in the transfer. It is what makes a payment findable by scanning the
  -- treasury WITHOUT the client ever reporting anything — the answer to "the
  -- player closed the tab". Relying only on a client-reported signature means a
  -- closed tab is stranded money.
  reference text not null unique,

  status text not null default 'pending'
    check (status in ('pending', 'credited', 'abandoned')),
  credited_at timestamptz
);

create index payment_intents_user_idx on public.payment_intents (user_id, created_at desc);
create index payment_intents_open_idx on public.payment_intents (status) where status = 'pending';

-- ================================================================ payments
--
-- One row per on-chain transaction we have credited. The signature is the
-- primary key and that is the entire replay defence.
create table public.payments (
  signature        text primary key,
  cluster          text not null check (cluster in ('devnet', 'mainnet-beta')),
  user_id          uuid references auth.users (id) on delete set null,
  intent_id        uuid references public.payment_intents (id) on delete set null,
  treasury_address text not null,
  usdc_mint        text not null,
  usdc_amount      numeric(20, 6) not null check (usdc_amount >= 0),
  chips_credited   bigint not null check (chips_credited >= 0),
  -- What we accepted as settled. Recorded rather than assumed so the bar can be
  -- raised later and old rows still explain themselves.
  commitment       text not null,
  observed_at      timestamptz not null default now(),
  ledger_id        bigint references public.ledger (id) on delete set null,
  -- Set when something arrived that we could not turn into chips, e.g. an
  -- amount below one chip. Flagged, never silently eaten.
  note             text
);

create index payments_user_idx on public.payments (user_id, observed_at desc);
create index payments_flagged_idx on public.payments (observed_at desc) where note is not null;

comment on table public.payments is
  'Signature is the primary key: one transaction credits exactly once, ever, enforced by the database rather than by a code path.';

-- ============================================================= ToS record
--
-- Blocking acceptance before a first purchase, versioned and timestamped. A
-- footer link is fine for a free game; the moment someone pays, "chips have no
-- cash value and cannot be converted back" should be something they actively
-- acknowledged and we can show they did.
create table public.tos_acceptances (
  user_id     uuid not null references auth.users (id) on delete cascade,
  version     text not null,
  accepted_at timestamptz not null default now(),
  primary key (user_id, version)
);

alter table public.payment_intents  enable row level security;
alter table public.payments         enable row level security;
alter table public.tos_acceptances  enable row level security;
alter table public.payment_config   enable row level security;

revoke all on public.payment_intents from anon, authenticated;
revoke all on public.payments        from anon, authenticated;
revoke all on public.tos_acceptances from anon, authenticated;
revoke all on public.payment_config  from anon, authenticated;

-- A player may READ their own payment history and their own acceptances, and
-- write none of it.
create policy payment_intents_select_own on public.payment_intents
  for select to authenticated using ((select auth.uid()) = user_id);
create policy payments_select_own on public.payments
  for select to authenticated using ((select auth.uid()) = user_id);
create policy tos_select_own on public.tos_acceptances
  for select to authenticated using ((select auth.uid()) = user_id);

grant select on public.payment_intents to authenticated;
grant select on public.payments        to authenticated;
grant select on public.tos_acceptances to authenticated;

-- payment_config stays server-only: the client is TOLD the recipient by the
-- intent it was issued, and has no reason to browse the table.

-- ledger gains the purchase reason.
alter table public.ledger drop constraint ledger_reason_check;
alter table public.ledger add constraint ledger_reason_check
  check (reason in ('match_reward', 'theme_unlock', 'chip_purchase'));

-- ================================================================== ToS RPC
create or replace function public.record_tos_acceptance(p_user_id uuid, p_version text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_version is null or length(p_version) = 0 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  insert into public.tos_acceptances (user_id, version)
  values (p_user_id, p_version)
  on conflict do nothing;
  return jsonb_build_object('ok', true, 'version', p_version);
end $$;

revoke all on function public.record_tos_acceptance(uuid, text) from public, anon, authenticated;

-- =========================================================== create intent
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

-- ========================================================== credit purchase
--
-- Called ONLY after the Edge Function has verified the transaction on-chain.
-- Every argument is a fact the server observed, never something the client
-- asserted. This function's job is to make crediting it exactly-once and
-- atomic with the ledger row.
create or replace function public.credit_purchase(
  p_signature   text,
  p_cluster     text,
  p_user_id     uuid,
  p_intent_id   uuid,
  p_treasury    text,
  p_mint        text,
  p_usdc_amount numeric,
  p_commitment  text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  it public.payment_intents;
  v_chips     bigint;
  v_ledger_id bigint;
  v_balance   bigint;
  v_note      text;
begin
  select * into it from public.payment_intents where id = p_intent_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if it.user_id <> p_user_id then return jsonb_build_object('error', 'not_found'); end if;

  -- The transaction must match what the intent FROZE, not what config says now.
  if it.cluster <> p_cluster
     or it.treasury_address <> p_treasury
     or it.usdc_mint <> p_mint then
    return jsonb_build_object('error', 'payment_mismatch');
  end if;

  -- Rate, not SKU: whatever actually arrived, at the rate the intent quoted.
  -- Underpay and get fewer chips; overpay and get more. No money is stranded
  -- and no support process is required for the ordinary mistakes.
  v_chips := floor(p_usdc_amount * it.chips_per_usdc)::bigint;
  if v_chips <= 0 then
    v_note := 'below_one_chip';
  end if;

  -- THE REPLAY DEFENCE. Claiming the signature comes first, and it is a primary
  -- key, so a second attempt with the same transaction inserts nothing and
  -- credits nothing — no matter how many times it is submitted, or by whom.
  insert into public.payments (
    signature, cluster, user_id, intent_id, treasury_address, usdc_mint,
    usdc_amount, chips_credited, commitment, note
  ) values (
    p_signature, p_cluster, p_user_id, p_intent_id, p_treasury, p_mint,
    p_usdc_amount, greatest(v_chips, 0), p_commitment, v_note
  )
  on conflict (signature) do nothing;

  if not found then
    return jsonb_build_object('ok', true, 'already_credited', true, 'signature', p_signature);
  end if;

  if v_chips > 0 then
    v_balance := public.credit_ledger(
      p_user_id, 'chips', v_chips, 'chip_purchase',
      'purchase:' || p_signature, null, null
    );
    select id into v_ledger_id from public.ledger
     where idem_key = 'purchase:' || p_signature;
    update public.payments set ledger_id = v_ledger_id where signature = p_signature;
  end if;

  update public.payment_intents
     set status = 'credited', credited_at = now()
   where id = p_intent_id and status <> 'credited';

  return jsonb_build_object(
    'ok', true,
    'already_credited', false,
    'signature', p_signature,
    'usdc_amount', p_usdc_amount,
    'chips_credited', greatest(v_chips, 0),
    'chips', coalesce(v_balance, (select chips from public.balances where user_id = p_user_id)),
    'note', v_note
  );
end $$;

revoke all on function public.credit_purchase(text, text, uuid, uuid, text, text, numeric, text)
  from public, anon, authenticated;

-- Anything that arrived but could not be turned into chips, for the owner to
-- see. Dust is flagged, never quietly absorbed.
create or replace function public.flagged_payments()
returns table (signature text, user_id uuid, usdc_amount numeric, note text, observed_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select signature, user_id, usdc_amount, note, observed_at
    from public.payments where note is not null order by observed_at desc;
$$;

revoke all on function public.flagged_payments() from public, anon, authenticated;
