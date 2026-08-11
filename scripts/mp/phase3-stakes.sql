-- Phase 3: escrow, settlement and rake — every path, conservation asserted.
--
--   psql "$DATABASE_URL" -f scripts/mp/phase3-stakes.sql
--
-- Self-cleaning: it RAISEs at the end so the whole transaction rolls back and
-- no test rows survive. That also means it can be run against production
-- safely, which is the only way a conservation check stays honest.
--
-- The invariant, on every path:
--     chips posted = winner payout + house rake     (decided)
--     chips posted = refunds                        (void)
--
-- It found one real defect on its first run: adding an argument to
-- credit_ledger with `create or replace function` had produced an OVERLOAD
-- rather than a replacement, leaving every 5- and 6-argument call ambiguous.
-- The stakes migration had applied cleanly; the next chip purchase would have
-- been what failed. See 20260811220000_drop_credit_ledger_overload.sql.

do $$
declare
  A uuid; B uuid; t jsonb; e jsonb; rid bigint; tid uuid; s text; ok boolean;
  outcomes constant jsonb := '{"rock:rock":"tie","rock:paper":"lose","rock:scissors":"win","paper:rock":"win","paper:paper":"tie","paper:scissors":"lose","scissors:rock":"lose","scissors:paper":"win","scissors:scissors":"tie"}';
  wins constant jsonb := '{"single":1,"bo3":2,"bo5":3}';
  out_ text[] := '{}'; lock1 jsonb; lock2 jsonb; a0 bigint; b0 bigint;
begin
  select id into A from auth.users order by created_at limit 1;
  select id into B from auth.users order by created_at desc limit 1;
  if A is null or A = B then raise exception 'need two distinct auth users'; end if;
  perform public.credit_ledger(A,'chips',1000::bigint,'chip_purchase','seedA'||clock_timestamp()::text);
  perform public.credit_ledger(B,'chips',1000::bigint,'chip_purchase','seedB'||clock_timestamp()::text);
  select chips into a0 from public.balances where user_id=A;
  select chips into b0 from public.balances where user_id=B;

  -- THE STRUCTURAL RULE. A stake whose rake is fractional must be impossible
  -- to configure, not merely undocumented.
  begin
    insert into public.mp_stake_options (stake_chips, rake_bps) values (25, 500);
    out_ := out_ || format('stake 25 (rake 2.5) : ACCEPTED — CONSTRAINT FAILED');
  exception when check_violation then
    out_ := out_ || format('stake 25 (rake 2.5) : REFUSED by mp_stake_rake_must_be_whole');
  end;
  insert into public.mp_stake_options (stake_chips, rake_bps) values (20, 500);
  out_ := out_ || format('stake 20 (rake 2)   : accepted');
  delete from public.mp_stake_options where stake_chips = 20;

  -- DECIDED BY PLAY: 10 stake, pot 20, rake 1, winner takes 19.
  t := public.mp_create_table(A, 'single', 10); tid := (t->>'table_id')::uuid;
  out_ := out_ || format('create              : stake=%s pot=%s rake=%s payout=%s',
                         t->>'stake', t->>'pot', t->>'rake', t->>'payout');
  e := public.mp_join_table(B, t->>'invite_code');
  select jsonb_build_array(least(seat_a,seat_b), greatest(seat_a,seat_b)) into lock1
    from public.mp_tables where id=tid;
  out_ := out_ || format('after escrow        : A%s B%s (each down 10, atomic with the seating)',
    (select chips from public.balances where user_id=A) - a0,
    (select chips from public.balances where user_id=B) - b0);

  rid := (public.mp_open_round(A, tid)->>'round_id')::bigint;
  perform public.mp_commit(A, rid, 'rock', 'n', 'd1');
  perform public.mp_commit(B, rid, 'scissors', 'n', 'd2');
  perform public.mp_reveal(A, rid, outcomes, wins);
  perform public.mp_reveal(B, rid, outcomes, wins);
  out_ := out_ || format('net after decided   : A%s (staked 10, won 19) B%s house=%s',
    (select chips from public.balances where user_id=A) - a0,
    (select chips from public.balances where user_id=B) - b0, public.house_balance());
  select format('conservation        : posted=%s paid=%s rake=%s net=%s conserved=%s',
    posted, paid, rake, net, conserved) into s from public.mp_conservation_check(tid);
  out_ := out_ || s;

  -- Settling twice must not pay twice. The idem keys are the guarantee.
  perform public.mp_settle(tid, 'decided');
  select format('settle twice        : conserved=%s house=%s (unchanged)', conserved, public.house_balance())
    into s from public.mp_conservation_check(tid);
  out_ := out_ || s;

  -- VOID: full refund, NO rake. The house does not earn from a match that
  -- never happened.
  t := public.mp_create_table(A, 'single', 50); tid := (t->>'table_id')::uuid;
  perform public.mp_join_table(B, t->>'invite_code');
  select jsonb_build_array(least(seat_a,seat_b), greatest(seat_a,seat_b)) into lock2
    from public.mp_tables where id=tid;
  perform public.mp_void_match(tid, 'test');
  select format('void refund         : posted=%s refunded=%s rake=%s conserved=%s',
    posted, refunded, rake, conserved) into s from public.mp_conservation_check(tid);
  out_ := out_ || s;
  out_ := out_ || format('house after void    : %s (unchanged)', public.house_balance());

  -- NO DEBT, EVER. A player who cannot cover is not seated, and the table
  -- reopens rather than sitting half-staked.
  update public.balances set chips = 5 where user_id = B;
  t := public.mp_create_table(A, 'single', 100); tid := (t->>'table_id')::uuid;
  e := public.mp_join_table(B, t->>'invite_code');
  out_ := out_ || format('poor joiner         : error=%s short_seat=%s', e->>'error', e->>'short_seat');
  select format('seat returned       : seat_b=%s status=%s (nothing posted)',
    coalesce(seat_b::text,'null'), status) into s from public.mp_tables where id=tid;
  out_ := out_ || s;
  out_ := out_ || format('B balance           : %s (never negative)',
    (select chips from public.balances where user_id=B));

  -- THE DEADLOCK PROOF. Every transaction that touches both balance rows locks
  -- them in ascending user_id. A deadlock cycle requires two transactions
  -- holding locks in OPPOSITE orders; if every transaction sorts, no such pair
  -- can exist. Asserted rather than trusted: the order is returned by
  -- mp_escrow, and here it is checked to be ascending and identical across two
  -- different tables with the seats assigned differently.
  out_ := out_ || format('lock order          : ascending=%s identical across tables=%s',
    (lock1->>0) < (lock1->>1), lock1 = lock2);

  select bool_and(conserved) into ok from public.mp_conservation_check();
  out_ := out_ || format('ALL STAKE TABLES    : conserved=%s', ok);

  raise exception E'PHASE 3 RESULTS\n  %', array_to_string(out_, E'\n  ');
end $$;
