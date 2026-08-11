-- The treasury wallet is infrastructure, not a player. It may not take a seat.
--
-- WHAT IS AND IS NOT TRUE HERE, because the guard should rest on the real
-- reason rather than the one that sounds worst.
--
-- Settlement does NOT pay the rake into a player balance. `house_ledger` is a
-- separate table with no user_id — deliberately, so the house could never be
-- confused with an account that can log in — and `mp_settle` credits it
-- directly. So a treasury seat would not have quietly paid itself its own
-- rake; that specific corruption is already structurally impossible and this
-- migration does not fix it.
--
-- What a treasury seat WOULD do:
--
--   * Put a play balance on an operational identity. The treasury key exists
--     to receive USDC and hold the mint authority. Chips accumulating on it
--     from winning matches make its balance mean two unrelated things at once,
--     and every future question about house income starts with "which of these
--     chips are rake and which are winnings?"
--
--   * Contradict a refusal we already ship. `create_payment_intent` refuses
--     `wallet_is_treasury` because a self-transfer can never credit. Letting
--     the same identity stake chips it is forbidden to buy is incoherent: it
--     can lose chips at a table and cannot replace them.
--
--   * Give anyone holding the operational key a seat at real-stake tables.
--     That key is shared and rotated for reasons that have nothing to do with
--     the game.
--
-- Free tables too, per the decision — one rule is easier to reason about than
-- a rule with a carve-out, and the carve-out would be the interesting case.
--
-- Checked against `profiles.wallet_address` — the value the provisioning
-- trigger copied out of the verified SIWS identity — never against anything
-- the client asserts, exactly as the purchase refusal does.

-- ACTIVE configurations only, across every cluster. A retired treasury address
-- is no longer the rake destination, so a rotated-out wallet becomes an
-- ordinary player again; a *current* treasury on any cluster is barred, which
-- is why this is a join against payment_config rather than a per-cluster
-- lookup like create_payment_intent's (that one has a cluster in hand and this
-- one does not — multiplayer has no notion of a chain).
create or replace function public.is_treasury_wallet(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
      join public.payment_config c
        on c.treasury_address = p.wallet_address
       and c.active
     where p.id = p_user_id
       and p.wallet_address is not null
  );
$$;
revoke all on function public.is_treasury_wallet(uuid) from public, anon, authenticated;

comment on function public.is_treasury_wallet(uuid) is
  'True when this account signs in with a currently-active treasury wallet. Used to keep infrastructure identities out of gameplay; compares against profiles.wallet_address, never a client-supplied value.';

-- ============================================================ cannot create
create or replace function public.mp_create_table(p_user_id uuid, p_format text, p_stake bigint default 0)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_code text; v_row public.mp_tables; v_opt public.mp_stake_options; v_bal bigint;
begin
  if not public.take_rate_token(p_user_id, 'mp_create') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  -- Before anything is written, and before the stake is even looked at: this
  -- refusal applies at every stake including 0.
  if public.is_treasury_wallet(p_user_id) then
    return jsonb_build_object('error', 'wallet_is_treasury');
  end if;

  if p_format not in ('single', 'bo3', 'bo5') then
    return jsonb_build_object('error', 'bad_request');
  end if;

  select * into v_opt from public.mp_stake_options where stake_chips = p_stake and active;
  if not found then return jsonb_build_object('error', 'bad_stake', 'stake', p_stake); end if;

  -- A soft gate only: the authoritative check is inside the escrow transaction
  -- when the second player sits. Refusing here as well means a player is told
  -- they cannot afford a table BEFORE they hand a code to a friend, rather
  -- than when the friend tries to join.
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

-- ============================================================== cannot join
create or replace function public.mp_join_table(p_user_id uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_row public.mp_tables; v_esc jsonb;
begin
  if not public.take_rate_token(p_user_id, 'mp_join') then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  perform public.mp_sweep();

  -- The reconnect branch stays ABOVE the guard on purpose. Refusing to let a
  -- seated player back into a match already in progress would strand their
  -- opponent and leave escrowed chips locked until the sweep. The migration
  -- voids any table the treasury currently occupies (see the end of this
  -- file), so after this deploys there is nothing for this branch to return
  -- for a treasury account — but "cannot sit down" must not become "cannot
  -- finish a hand you are already in", for anyone.
  select * into v_row from public.mp_tables
   where invite_code = upper(p_code) and p_user_id in (seat_a, seat_b)
     and status in ('open', 'playing');
  if found then
    return jsonb_build_object('ok', true, 'table_id', v_row.id, 'status', v_row.status,
      'format', v_row.format, 'already_seated', true, 'stake', v_row.stake_chips,
      'pot', v_row.pot_chips, 'rake', v_row.rake_chips, 'payout', v_row.payout_chips,
      'seat', case when v_row.seat_a = p_user_id then 'a' else 'b' end);
  end if;

  -- Taking a NEW seat. Refused before the seat update, so nothing has to be
  -- compensated and no escrow is ever attempted.
  if public.is_treasury_wallet(p_user_id) then
    return jsonb_build_object('error', 'wallet_is_treasury');
  end if;

  update public.mp_tables
     set seat_b = p_user_id, status = 'playing'
   where invite_code = upper(p_code)
     and status = 'open' and seat_b is null and seat_a <> p_user_id
     and expires_at > now()
  returning * into v_row;

  if not found then
    return jsonb_build_object('error', 'table_unavailable');
  end if;

  -- Escrow in the SAME transaction as the seating. If either player cannot
  -- cover, the seat is given back and the table reopens — there is no state in
  -- which a match exists half-staked, and none in which a player is seated at
  -- a table they could not afford.
  v_esc := public.mp_escrow(v_row.id);
  if v_esc ? 'error' then
    update public.mp_tables set seat_b = null, status = 'open' where id = v_row.id;
    return v_esc;
  end if;

  return jsonb_build_object('ok', true, 'table_id', v_row.id, 'status', v_row.status,
    'format', v_row.format, 'seat', 'b', 'stake', v_row.stake_chips,
    'pot', v_esc ->> 'pot', 'rake', v_esc ->> 'rake', 'payout', v_esc ->> 'payout');
end $$;
revoke all on function public.mp_join_table(uuid, text) from public, anon, authenticated;

-- ========================================== a kind for it, and why that's ok
--
-- Widening `integrity_events_kind_check` is the move I refused for reveal
-- latency, so the distinction is worth stating: that was per-round telemetry,
-- thousands of rows a week saying nothing is wrong, which would have drowned
-- the signal the table exists for. This is the opposite — a row here means an
-- infrastructure identity was sitting at a game table, which is precisely
-- "something might be wrong" and precisely what a digest should surface. It
-- should be permanently zero.
alter table public.integrity_events drop constraint integrity_events_kind_check;
alter table public.integrity_events add constraint integrity_events_kind_check
  check (kind in (
    'commitment_mismatch',
    'outcome_disagreement',
    'reveal_before_move',
    'move_changed_after_resolution',
    'expired_round_submission',
    'rate_limited',
    'treasury_seat_voided'           -- server: a treasury wallet held a seat
  ));

-- ================================================ clear the existing seats
--
-- A guard that only applies to future actions leaves whatever is already
-- there. Any table the treasury currently sits at is voided — which refunds
-- both stakes in full through the normal void path, with no rake, exactly as
-- an abandoned match does. Expected to affect zero rows in production; written
-- because "expected zero" is not the same as "checked".
do $$
declare v_tid uuid; v_n int := 0;
begin
  for v_tid in
    select t.id from public.mp_tables t
     where t.status in ('open', 'playing')
       and (public.is_treasury_wallet(t.seat_a) or public.is_treasury_wallet(t.seat_b))
  loop
    perform public.mp_void_match(v_tid, 'treasury_may_not_sit');
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then
    insert into public.integrity_events (kind, source, detail)
    values ('treasury_seat_voided', 'server', jsonb_build_object(
      'why', 'treasury_may_not_sit', 'tables_voided', v_n));
  end if;
end $$;
