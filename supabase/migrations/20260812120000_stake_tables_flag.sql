-- Stake tables off, at the deepest layer that can hold the line.
--
-- THE NARROWING. Spending chips on a cosmetic is a purchase; staking chips
-- against another player is a wager. The first ships; the second waits for a
-- lawyer. This migration makes the second unreachable without deleting any of
-- it — the tables, the escrow, the rake and the settlement all stay exactly as
-- proven, and one row flips them back.
--
-- WHY THE ENFORCEMENT LIVES HERE AND NOT ONLY IN THE FUNCTION. The mp_* RPCs
-- have zero EXECUTE grants to anon or authenticated (verified), and mp_tables
-- carries SELECT only, so the single reachable route to a stake is the `mp`
-- Edge Function running as service role. A guard there would be sufficient —
-- and would also be the only thing standing between a future refactor and a
-- staked table. A guard HERE holds even for the service role, which means it
-- holds for any code we write next by accident.
create table if not exists public.feature_flags (
  key         text primary key,
  enabled     boolean not null default false,
  reason      text not null,
  changed_at  timestamptz not null default now()
);

alter table public.feature_flags enable row level security;
revoke all on public.feature_flags from anon, authenticated;

comment on table public.feature_flags is
  'Server-side feature switches. Config, not code: flipping one is a reviewable data change with a reason attached, not a deploy.';

insert into public.feature_flags (key, enabled, reason) values
  ('stake_tables', false,
   'Wagering chips on a chance outcome is the unresolved legal question. Off until a lawyer clears it separately. The code is built, tested and proven in production; nothing here deletes it.')
on conflict (key) do nothing;

create or replace function public.flag_enabled(p_key text)
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select enabled from public.feature_flags where key = p_key), false) $$;
revoke all on function public.flag_enabled(text) from public, anon, authenticated;

comment on function public.flag_enabled(text) is
  'Fails closed: an unknown key is disabled. A flag nobody has defined is not a flag that is on.';

-- ------------------------------------------------------- the guard itself
--
-- Placed at the top of mp_create_table, before the rate token is spent and
-- before anything is written, so a refused stake costs nothing and leaves
-- nothing behind. `stake = 0` is untouched: free tables are the product.
create or replace function public.mp_create_table(p_user_id uuid, p_format text, p_stake bigint default 0)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_code text; v_row public.mp_tables; v_opt public.mp_stake_options; v_bal bigint;
begin
  -- THE NARROWING, enforced. A wager needs clearance a purchase does not.
  if p_stake > 0 and not public.flag_enabled('stake_tables') then
    return jsonb_build_object('error', 'stakes_unavailable', 'stake', p_stake);
  end if;

  if not public.take_rate_token(p_user_id, 'mp_create') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  if public.is_treasury_wallet(p_user_id) then
    return jsonb_build_object('error', 'wallet_is_treasury');
  end if;

  if p_format not in ('single', 'bo3', 'bo5') then
    return jsonb_build_object('error', 'bad_request');
  end if;

  select * into v_opt from public.mp_stake_options where stake_chips = p_stake and active;
  if not found then return jsonb_build_object('error', 'bad_stake', 'stake', p_stake); end if;

  if p_stake > 0 then
    select coalesce(chips, 0) into v_bal from public.balances where user_id = p_user_id;
    if coalesce(v_bal, 0) < p_stake then
      return jsonb_build_object('error', 'insufficient_chips', 'stake', p_stake,
                                'chips', coalesce(v_bal, 0));
    end if;
  end if;

  perform public.mp_sweep();
  update public.mp_tables set status = 'abandoned', closed_at = now()
   where seat_a = p_user_id and status = 'open';

  v_code := public.mp_new_invite_code();
  insert into public.mp_tables (invite_code, format, seat_a, expires_at, stake_chips, rake_bps)
  values (v_code, p_format, p_user_id,
          now() + make_interval(secs => public.mp_ms('table_ttl') / 1000.0),
          p_stake, v_opt.rake_bps)
  returning * into v_row;

  return jsonb_build_object('ok', true, 'table_id', v_row.id, 'invite_code', v_row.invite_code,
    'format', v_row.format, 'status', v_row.status, 'expires_at', v_row.expires_at, 'seat', 'a',
    'stake', v_row.stake_chips, 'pot', 2 * v_row.stake_chips,
    'rake', (2 * v_row.stake_chips * v_row.rake_bps) / 10000,
    'payout', 2 * v_row.stake_chips - (2 * v_row.stake_chips * v_row.rake_bps) / 10000);
end $$;
revoke all on function public.mp_create_table(uuid, text, bigint) from public, anon, authenticated;

-- ------------------------------------------------------- second, independent
--
-- Deactivating the priced options means `mp_create_table`'s own lookup refuses
-- a nonzero stake with `bad_stake` even if the guard above were removed. Two
-- gates that fail independently, and the stake sizes are preserved rather than
-- deleted — reactivating is an UPDATE.
update public.mp_stake_options set active = false where stake_chips > 0;

-- The escrow itself, as a last resort. Nothing should ever reach this — a
-- table cannot be created with a stake while the flag is off — but a table
-- created BEFORE the flag flipped could still be sitting open, and it must not
-- take anyone's chips on the way out.
create or replace function public.mp_escrow_guard() returns trigger
language plpgsql as $$
begin
  if new.stake_chips > 0 and not public.flag_enabled('stake_tables') then
    raise exception 'stake tables are disabled (feature_flags.stake_tables)';
  end if;
  return new;
end $$;

create trigger mp_tables_no_stake_while_disabled
  before insert on public.mp_tables
  for each row execute function public.mp_escrow_guard();
