-- Which tokens a player may PAY WITH. The treasury still receives USDC only —
-- this table is the allow-list for the input side of a swap-routed purchase,
-- and it is deliberately tight: a handful of liquid, well-known mints, seeded
-- here, never user-supplied. An arbitrary token list is a route to someone
-- paying in something worthless that quotes well and settles badly.
--
-- Trust does not rest on this table's client visibility: the server re-checks
-- the mint against this table on every quote. The client's copy is for
-- rendering a picker, nothing else.
create table public.accepted_input_tokens (
  mint       text primary key,
  cluster    text not null check (cluster in ('devnet', 'mainnet-beta')),
  symbol     text not null,
  name       text not null,
  decimals   int  not null check (decimals between 0 and 12),
  active     boolean not null default true,
  -- Devnet only: Jupiter does not exist on devnet, so the devnet quote
  -- provider is the harness itself — a fixed rate and a liquidity wallet that
  -- receives the input leg. Structurally impossible to describe for mainnet.
  harness_rate_usdc numeric,
  liquidity_wallet  text,
  created_at timestamptz not null default now(),
  constraint harness_fields_devnet_only check (
    cluster = 'devnet' or (harness_rate_usdc is null and liquidity_wallet is null)
  )
);

comment on table public.accepted_input_tokens is
  'Input-side allow-list for swap-routed chip purchases. The treasury always receives USDC; these are the tokens a player may pay with. Server-validated on every quote.';

alter table public.accepted_input_tokens enable row level security;
revoke all on public.accepted_input_tokens from anon, authenticated;

-- Players may read the active list to render a picker, and write none of it.
create policy accepted_input_tokens_select_active on public.accepted_input_tokens
  for select to authenticated using (active);
grant select on public.accepted_input_tokens to authenticated;

-- Same interlock as payment_config (see 20260810131500): a harness-authored
-- mint must be refused BY IDENTITY on mainnet, in both directions, so neither
-- write order sneaks past. A test mint as a mainnet input token is less
-- catastrophic than one as the treasury mint — the amount check still measures
-- real USDC arriving — but it would let the UI advertise a worthless token as
-- payable, and there is no reason to leave the door ajar.
create or replace function public.forbid_test_mint_as_input_token()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'accepted_input_tokens' then
    if new.cluster = 'mainnet-beta'
       and exists (select 1 from public.test_mints where mint = new.mint) then
      raise exception
        'refusing mainnet input token %: it is a registered test mint whose authority is held by the devnet harness',
        new.mint;
    end if;
  else
    if exists (
      select 1 from public.accepted_input_tokens
       where cluster = 'mainnet-beta' and mint = new.mint
    ) then
      raise exception
        'refusing to register % as a test mint: a mainnet input token row already names it',
        new.mint;
    end if;
  end if;
  return new;
end $$;

create trigger accepted_input_tokens_no_test_mint
  before insert or update on public.accepted_input_tokens
  for each row execute function public.forbid_test_mint_as_input_token();

create trigger test_mints_no_mainnet_input_token
  before insert or update on public.test_mints
  for each row execute function public.forbid_test_mint_as_input_token();

-- Mainnet seeds, INACTIVE. Nothing here enables real money: mainnet payment
-- config is fail-closed off, and these rows are additionally inert until
-- someone flips `active` as part of the mainnet activation checklist. They are
-- seeded now so the list is reviewed code, not a launch-day ad-lib.
insert into public.accepted_input_tokens (mint, cluster, symbol, name, decimals, active)
values
  ('So11111111111111111111111111111111111111112', 'mainnet-beta', 'SOL',  'Solana (wrapped)', 9, false),
  ('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'mainnet-beta', 'USDT', 'Tether USD',       6, false),
  ('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  'mainnet-beta', 'mSOL', 'Marinade SOL',     9, false)
on conflict (mint) do nothing;

-- No devnet seeds: the harness registers its own test tokens at setup, the
-- same way it registers test mints.
