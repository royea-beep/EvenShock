-- Store the bare wallet address, not the namespaced identity id.
--
-- Supabase's Web3 provider sets identity.provider_id to `web3:solana:<address>`,
-- and the provisioning trigger's last-resort fallback copied it verbatim. Real
-- sign-ins therefore landed as:
--
--   web3:solana:D9bzBJ2Sv96XVK9udrhWVPNKCg2pSQzKzGUoKvujBSRF
--
-- Nothing breaks, which is what makes it worth fixing now: the leaderboard
-- shortens an unnamed player to first-4 + last-4, so this renders as
-- `web3…BSRF` for every wallet — identical prefixes, and the part that
-- identifies the player thrown away.

create or replace function public.strip_wallet_namespace(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- Trims a leading `web3:<chain>:` (or any `<scheme>:<chain>:`) prefix and
  -- leaves a bare address untouched. Anchored and non-greedy so an address that
  -- happens to contain a colon keeps everything after the namespace.
  select case
    when p_value ~ '^[a-z0-9]+:[a-z0-9]+:.+$'
      then regexp_replace(p_value, '^[a-z0-9]+:[a-z0-9]+:', '')
    else p_value
  end;
$$;

create or replace function public.handle_new_web3_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  address text;
begin
  address := coalesce(
    nullif(new.identity_data ->> 'address', ''),
    nullif(new.identity_data ->> 'wallet_address', ''),
    -- provider_id is namespaced (`web3:solana:<address>`), so it is normalised
    -- rather than taken as-is. The two keys above are already bare.
    public.strip_wallet_namespace(nullif(new.provider_id, ''))
  );

  if address is null then
    return new;
  end if;

  if new.provider not in ('web3', 'solana', 'ethereum') then
    return new;
  end if;

  insert into public.profiles (id, wallet_address)
  values (new.user_id, address)
  on conflict (id) do update
    set wallet_address = excluded.wallet_address,
        updated_at     = now();

  return new;
end;
$$;

revoke all on function public.handle_new_web3_identity() from public, anon, authenticated;

create or replace function public.ensure_profile()
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  address text;
  row_out public.profiles;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select coalesce(
           nullif(i.identity_data ->> 'address', ''),
           nullif(i.identity_data ->> 'wallet_address', ''),
           public.strip_wallet_namespace(nullif(i.provider_id, ''))
         )
    into address
    from auth.identities i
   where i.user_id = auth.uid()
     and i.provider in ('web3', 'solana', 'ethereum')
   order by i.created_at
   limit 1;

  if address is null then
    raise exception 'no verified web3 identity for this user';
  end if;

  insert into public.profiles (id, wallet_address)
  values (auth.uid(), address)
  on conflict (id) do nothing;

  select * into row_out from public.profiles where id = auth.uid();
  return row_out;
end;
$$;

revoke all on function public.ensure_profile() from public, anon;
grant execute on function public.ensure_profile() to authenticated;

-- Backfill the rows written before the fix.
update public.profiles
   set wallet_address = public.strip_wallet_namespace(wallet_address),
       updated_at     = now()
 where wallet_address ~ '^[a-z0-9]+:[a-z0-9]+:.+$';
