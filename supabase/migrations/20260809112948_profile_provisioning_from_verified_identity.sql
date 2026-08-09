-- The wallet address becomes ours only after Supabase Auth has verified the
-- signature and written the identity. Reading it from auth.identities rather
-- than accepting it from the client is the whole point: connecting a wallet
-- only tells us a claimed address, and a claimed address is worth nothing.
--
-- Triggered on auth.identities, not auth.users, because the address lives on
-- the identity and the identity row is written after the user row. A trigger on
-- auth.users would fire too early and have nothing to copy.

create or replace function public.handle_new_web3_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  address text;
begin
  -- Supabase records the wallet address as the identity identifier. Some
  -- providers also mirror it into identity_data; prefer that when present and
  -- fall back to provider_id, so this survives either shape.
  address := coalesce(
    nullif(new.identity_data ->> 'address', ''),
    nullif(new.identity_data ->> 'wallet_address', ''),
    nullif(new.provider_id, '')
  );

  if address is null then
    return new;
  end if;

  -- Only Web3 identities carry a wallet. An email or OAuth identity linked
  -- later must not overwrite the address with its own provider_id.
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

create trigger on_web3_identity_created
  after insert on auth.identities
  for each row execute function public.handle_new_web3_identity();

-- A signed-in user whose profile row is missing for any reason -- the trigger
-- not having fired, an account created before this migration -- can call this
-- once to provision themselves. It still reads the address from the verified
-- identity, so it is not a way to claim someone else's wallet.
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
           nullif(i.provider_id, '')
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
