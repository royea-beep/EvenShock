-- Void settlement refunds WHAT WAS POSTED, read from the ledger — not "both
-- seats, one stake each", which was an assumption disguised as a fact.
--
-- FOUND BY: the Phase 3 suite, on the run that added the treasury guard. It
-- crashed with a not-null violation on `ledger.user_id`, from
-- credit_ledger(t.seat_b, ...) inside mp_settle's void branch.
--
-- THE BUG: a stake table nobody joined has seat_b = null. Voiding it — which
-- happens on the TTL sweep, and when the creator opens a second table, and on
-- mp_void_match — passed null into credit_ledger and raised.
--
-- WHY IT MATTERED MORE THAN IT LOOKS: mp_sweep() runs inside every
-- mp_create_table and every mp_join_table. So a SINGLE abandoned unjoined
-- stake table would have raised for every player attempting either action,
-- not just for its creator. Multiplayer would have died table-wide the first
-- time someone made a stake table their friend never joined — which is the
-- single most likely thing to happen on day one.
--
-- WHY THE OBVIOUS FIX IS WORSE THAN THE BUG: skipping the refund when seat_b
-- is null still refunds seat_a its stake. But escrow runs at JOIN, in
-- mp_escrow, and posts BOTH stakes together — an unjoined table has posted
-- nothing at all. Refunding seat_a there would credit chips that were never
-- debited, which is exactly the minting this whole file exists to prevent. The
-- crash was loud; that would have been silent.
--
-- THE FIX: refund each seat exactly what that seat posted, summed from
-- `ledger` where reason = 'stake_post'. Zero posts means zero refunds and a
-- settled, conserved table. It is also strictly stronger than reading
-- stake_chips: if escrow ever posted an amount that disagreed with the table's
-- stake, the refund still returns precisely what was taken.
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

  -- Same total order as mp_escrow. Settlement touches the same two rows, so it
  -- has to sort by the same rule or it reintroduces the cycle escrow avoided.
  -- least()/greatest() ignore nulls, so an unjoined table locks seat_a twice
  -- rather than locking null — harmless, and it keeps one code path.
  v_first  := least(t.seat_a, t.seat_b);
  v_second := greatest(t.seat_a, t.seat_b);
  perform 1 from public.balances where user_id = v_first  for update;
  perform 1 from public.balances where user_id = v_second for update;

  if p_kind = 'decided' then
    if t.result is null then return jsonb_build_object('error', 'no_result'); end if;
    v_winner := case when t.result = 'a' then t.seat_a else t.seat_b end;
    v_loser  := case when t.result = 'a' then t.seat_b else t.seat_a end;

    perform public.credit_ledger(v_winner, 'chips', t.payout_chips, 'stake_payout',
      'payout:' || t.id::text || ':' || v_winner::text, null, null, t.id);

    if t.rake_chips > 0 then
      insert into public.house_ledger (delta, reason, table_id, idem_key, balance_after)
      values (t.rake_chips, 'rake', t.id, 'rake:' || t.id::text, 0)
      on conflict (idem_key) do nothing;
      -- balance_after is written after the insert so it reflects the row's own
      -- position in the running total rather than a value computed before it.
      select public.house_balance() into v_house;
      update public.house_ledger set balance_after = v_house
       where idem_key = 'rake:' || t.id::text;
    end if;

  elsif p_kind = 'void' then
    -- The house does not earn from a match that never happened. Full refund of
    -- everything posted, no rake — stated as an explicit branch rather than a
    -- rake of zero, so nobody later "simplifies" it into taking a cut.
    --
    -- Driven by the ledger rather than by the seats: a seat that never posted
    -- gets nothing back, because it never put anything in.
    for v_seat, v_posted in
      select l.user_id, -sum(l.delta)
        from public.ledger l
       where l.mp_table_id = t.id and l.reason = 'stake_post'
       group by l.user_id
    loop
      perform public.credit_ledger(v_seat, 'chips', v_posted, 'stake_refund',
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
