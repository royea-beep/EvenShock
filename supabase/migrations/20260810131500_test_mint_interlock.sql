-- The devnet test harness mints its own currency. This is the interlock that
-- makes it structurally incapable of touching real money.
--
-- Everything else guarding the harness lives in the harness: it asks the chain
-- for its genesis hash and refuses to hand out keys unless the answer is
-- devnet's. That is a good gate and it is also the wrong place for the LAST
-- gate, because it disappears the moment someone rewrites the script. A
-- constraint in the database does not. Whoever picks this up in a year, with no
-- memory of why, still cannot point a self-minting test currency at mainnet.
--
-- The threat is not subtle: our mint authority can conjure unlimited balance.
-- If a mainnet payment_config ever names that mint, verification passes
-- honestly — the transfer really happened, the treasury really received it —
-- and chips are credited for currency that cost nothing. Every check in
-- verifyOnChain would do its job correctly and the outcome would still be free
-- chips. So the mint must be refused by IDENTITY, upstream of any amount.

-- Every mint the harness creates registers here. The cluster check is pinned
-- rather than a default: a test mint cannot even be DESCRIBED as mainnet.
create table public.test_mints (
  mint       text primary key,
  cluster    text not null check (cluster = 'devnet'),
  note       text,
  created_at timestamptz not null default now()
);

comment on table public.test_mints is
  'Mints created by the devnet harness, which holds their mint authority. Registration here makes a mint permanently unusable on mainnet — see forbid_test_mint_on_mainnet.';

alter table public.test_mints enable row level security;
revoke all on public.test_mints from anon, authenticated;

-- Guarded in BOTH directions. One trigger alone is bypassed by ordering: with
-- only the payment_config check you register the mint afterwards; with only the
-- test_mints check you write the mainnet row first. Neither order works when
-- both exist.
create or replace function public.forbid_test_mint_on_mainnet()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'payment_config' then
    if new.cluster = 'mainnet-beta'
       and exists (select 1 from public.test_mints where mint = new.usdc_mint) then
      raise exception
        'refusing mainnet payment_config for %: it is a registered test mint whose authority is held by the devnet harness',
        new.usdc_mint;
    end if;
  else
    if exists (
      select 1 from public.payment_config
       where cluster = 'mainnet-beta' and usdc_mint = new.mint
    ) then
      raise exception
        'refusing to register % as a test mint: a mainnet payment_config already names it',
        new.mint;
    end if;
  end if;
  return new;
end $$;

create trigger payment_config_no_test_mint
  before insert or update on public.payment_config
  for each row execute function public.forbid_test_mint_on_mainnet();

create trigger test_mints_no_mainnet_mint
  before insert or update on public.test_mints
  for each row execute function public.forbid_test_mint_on_mainnet();

-- Belt and braces at the moment money would actually move. The triggers above
-- stop the configuration ever existing; this stops a credit even if one somehow
-- does — a row written before this migration, a restore from an old dump, a
-- superuser with triggers disabled. Cheap, and it is the last thing standing
-- between a fake dollar and a real balance.
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

  -- Identity, not amount. A harness-authored mint on mainnet is refused before
  -- anything is counted, because the amount is not the thing that is wrong.
  if it.cluster = 'mainnet-beta'
     and exists (select 1 from public.test_mints where mint = it.usdc_mint) then
    return jsonb_build_object('error', 'test_mint_on_mainnet');
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

-- Unrelated to the interlock, found while building the harness: reconcile was
-- reading decimals it had never been given.
--
-- `open_intents_for_reconcile` returned every frozen field EXCEPT usdc_decimals,
-- so the Edge Function filled in a literal 6. Correct for USDC and silently
-- wrong for anything else — and the value scales the amount, so being wrong
-- means crediting a player 1000x or 1/1000th of what they paid. It costs
-- nothing to return the column that already exists.
--
-- Dropped rather than replaced: adding an OUT column changes the row type, and
-- `create or replace` refuses that. Safe here because the only caller is the
-- Edge Function, which is deployed from this same commit.
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
   where i.status = 'pending'
     and i.created_at > now() - p_max_age
   order by i.created_at;
$$;

revoke all on function public.open_intents_for_reconcile(interval) from public, anon, authenticated;
