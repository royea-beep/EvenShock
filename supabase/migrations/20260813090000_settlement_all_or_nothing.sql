-- Settlement must be all-or-nothing IN EFFECT, not just in transaction scope.
--
-- THE HOLE (found by the owner, reading the deployed functions):
--
--   credit_ledger:  on conflict (idem_key) do nothing ... return null
--   mp_settle:      perform public.credit_ledger(...)
--
-- `perform` discards the return value. So a payout whose insert conflicts —
-- or is skipped because the delta is zero — vanishes silently while the same
-- transaction writes the rake and marks the table settled. One transaction,
-- yes; one OUTCOME, no. The idempotent-null is load-bearing where a retry is
-- legitimate (a replayed confirm), and poison where the caller is asserting
-- "this credit MUST happen now" — and mp_settle is the second kind of caller
-- on every line.
--
-- For the record, and verified with timestamps: this hole did NOT produce the
-- 0dca3e39 anomaly (that table settled completely and conserved; its rows were
-- deleted three hours later by a harness reset — see the integrity_events note
-- written alongside this migration). The hole is real anyway. A defect does
-- not need to have fired yet to be a defect on a money path.
--
-- THE FIX: a strict variant that treats "nothing was written" as an error, and
-- mp_settle and mp_escrow rewritten to use it for every movement they assert.
-- If any credit fails to land, the whole settlement — rake included — rolls
-- back and the table stays unsettled for the sweep to retry.
--
-- AUDIT OF THE OTHER CALL SITES, as of this migration:
--   resolve_round     match rewards via `perform` — same pattern. A silent
--                     skip shortchanges a player but does NOT break
--                     minted = players + house (an unminted reward subtracts
--                     from both sides). Deferred with its own test; it is the
--                     live game's hot path and changes there are not made in
--                     the same commit as a settlement fix.
--   credit_purchase   captures the return but never checks null; a no-op
--                     would answer "chips_credited: N" having credited 0. It
--                     is reachable only if a ledger row exists for a signature
--                     with no payments row (requires manual deletion).
--                     Deferred, same reasoning, recorded in the checklist.

create or replace function public.credit_ledger_strict(
  p_user_id  uuid,
  p_currency text,
  p_delta    bigint,
  p_reason   text,
  p_idem_key text,
  p_match_id uuid default null,
  p_sku      text default null,
  p_mp_table_id uuid default null
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_balance bigint;
begin
  v_balance := public.credit_ledger(p_user_id, p_currency, p_delta, p_reason,
                                    p_idem_key, p_match_id, p_sku, p_mp_table_id);
  if v_balance is null then
    -- Zero-delta and idem-conflict both land here. At a strict call site
    -- neither is acceptable: the caller is asserting a movement, and a
    -- movement that did not happen must fail loudly enough to take the whole
    -- settlement with it.
    raise exception 'ledger credit did not land: user=% reason=% delta=% idem=%',
      p_user_id, p_reason, p_delta, p_idem_key
      using errcode = 'P0001';
  end if;
  return v_balance;
end $$;
revoke all on function public.credit_ledger_strict(uuid, text, bigint, text, text, uuid, text, uuid)
  from public, anon, authenticated;

comment on function public.credit_ledger_strict(uuid, text, bigint, text, text, uuid, text, uuid) is
  'credit_ledger that refuses to be a no-op. For call sites asserting a movement (settlement, escrow), where a silent skip would diverge intent from ledger. Retry-tolerant sites keep using credit_ledger.';

-- ------------------------------------------------- mp_settle, strict
create or replace function public.mp_settle(p_table_id uuid, p_kind text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  t public.mp_tables;
  v_winner uuid; v_loser uuid; v_first uuid; v_second uuid;
  v_house bigint; v_seat uuid; v_posted bigint; v_refunded bigint := 0;
begin
  select * into t from public.mp_tables where id = p_table_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if t.settled_at is not null then
    return jsonb_build_object('ok', true, 'already_settled', t.settlement);
  end if;

  if t.stake_chips = 0 then
    update public.mp_tables set settled_at = now(), settlement = p_kind where id = t.id;
    return jsonb_build_object('ok', true, 'free', true);
  end if;

  v_first  := least(t.seat_a, t.seat_b);
  v_second := greatest(t.seat_a, t.seat_b);
  perform 1 from public.balances where user_id = v_first  for update;
  perform 1 from public.balances where user_id = v_second for update;

  if p_kind = 'decided' then
    if t.result is null then return jsonb_build_object('error', 'no_result'); end if;
    v_winner := case when t.result = 'a' then t.seat_a else t.seat_b end;
    v_loser  := case when t.result = 'a' then t.seat_b else t.seat_a end;

    -- STRICT: if this payout does not land — conflict, zero, anything — the
    -- raise aborts the transaction and the rake below never fires. The
    -- settled_at guard above is what makes a legitimate retry safe: a settled
    -- table returns early and never reaches this line twice.
    perform public.credit_ledger_strict(v_winner, 'chips', t.payout_chips, 'stake_payout',
      'payout:' || t.id::text || ':' || v_winner::text, null, null, t.id);

    if t.rake_chips > 0 then
      insert into public.house_ledger (delta, reason, table_id, idem_key, balance_after)
      values (t.rake_chips, 'rake', t.id, 'rake:' || t.id::text, 0)
      on conflict (idem_key) do nothing;
      -- The same strictness for the house: a rake that silently failed to
      -- write while the payout succeeded is the same divergence mirrored.
      if not found then
        raise exception 'rake did not land: table=%', t.id using errcode = 'P0001';
      end if;
      select public.house_balance() into v_house;
      update public.house_ledger set balance_after = v_house
       where idem_key = 'rake:' || t.id::text;
    end if;

  elsif p_kind = 'void' then
    -- Refund exactly what was posted, per seat, from the ledger — and every
    -- refund must land. A seat that never posted is not in this loop.
    for v_seat, v_posted in
      select l.user_id, -sum(l.delta)
        from public.ledger l
       where l.mp_table_id = t.id and l.reason = 'stake_post'
       group by l.user_id
    loop
      perform public.credit_ledger_strict(v_seat, 'chips', v_posted, 'stake_refund',
        'refund:' || t.id::text || ':' || v_seat::text, null, null, t.id);
      v_refunded := v_refunded + v_posted;
    end loop;
  else
    return jsonb_build_object('error', 'bad_kind');
  end if;

  update public.mp_tables
     set settled_at = now(), settlement = p_kind,
         status = 'finished', closed_at = coalesce(closed_at, now())
   where id = t.id;

  return jsonb_build_object('ok', true, 'kind', p_kind, 'pot', t.pot_chips,
    'payout', case when p_kind = 'decided' then t.payout_chips else v_refunded end,
    'rake', case when p_kind = 'decided' then t.rake_chips else 0 end,
    'refunded', v_refunded,
    'winner', v_winner, 'house_balance', public.house_balance());
end $$;
revoke all on function public.mp_settle(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------- mp_escrow, strict
--
-- The exists-guard above the posts already makes a legitimate re-call return
-- 'already_escrowed' before reaching them, so at the point of posting, a
-- no-op is never a retry — it is always an anomaly.
create or replace function public.mp_escrow(p_table_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  t public.mp_tables;
  v_first uuid; v_second uuid;
  v_bal_a bigint; v_bal_b bigint;
  v_pot bigint; v_rake bigint;
begin
  select * into t from public.mp_tables where id = p_table_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if t.seat_b is null then return jsonb_build_object('error', 'no_opponent'); end if;

  if t.stake_chips = 0 then
    return jsonb_build_object('ok', true, 'free', true, 'pot', 0);
  end if;

  if exists (select 1 from public.ledger
              where mp_table_id = t.id and reason = 'stake_post') then
    return jsonb_build_object('ok', true, 'already_escrowed', true, 'pot', t.pot_chips);
  end if;

  v_first  := least(t.seat_a, t.seat_b);
  v_second := greatest(t.seat_a, t.seat_b);
  perform 1 from public.balances where user_id = v_first  for update;
  perform 1 from public.balances where user_id = v_second for update;

  select coalesce(chips, 0) into v_bal_a from public.balances where user_id = t.seat_a;
  select coalesce(chips, 0) into v_bal_b from public.balances where user_id = t.seat_b;

  if coalesce(v_bal_a, 0) < t.stake_chips or coalesce(v_bal_b, 0) < t.stake_chips then
    return jsonb_build_object(
      'error', 'insufficient_chips',
      'stake', t.stake_chips,
      'short_seat', case when coalesce(v_bal_a,0) < t.stake_chips then 'a' else 'b' end,
      'lock_order', jsonb_build_array(v_first, v_second));
  end if;

  v_pot  := 2 * t.stake_chips;
  v_rake := (v_pot * t.rake_bps) / 10000;

  perform public.credit_ledger_strict(t.seat_a, 'chips', -t.stake_chips, 'stake_post',
    'stake:' || t.id::text || ':' || t.seat_a::text, null, null, t.id);
  perform public.credit_ledger_strict(t.seat_b, 'chips', -t.stake_chips, 'stake_post',
    'stake:' || t.id::text || ':' || t.seat_b::text, null, null, t.id);

  update public.mp_tables
     set pot_chips = v_pot, rake_chips = v_rake, payout_chips = v_pot - v_rake
   where id = t.id;

  return jsonb_build_object('ok', true, 'pot', v_pot, 'rake', v_rake,
                            'payout', v_pot - v_rake,
                            'lock_order', jsonb_build_array(v_first, v_second));
end $$;
revoke all on function public.mp_escrow(uuid) from public, anon, authenticated;
