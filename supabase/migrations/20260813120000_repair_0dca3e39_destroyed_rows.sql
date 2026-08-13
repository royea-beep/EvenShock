-- Repair of the 0dca3e39 incident: re-insert the two destroyed ledger rows.
--
-- AUTHORIZATION. Ledger data is never edited on the initiative of anyone but
-- the owner. This repair was explicitly authorized by the owner on 2026-08-13
-- ("Repair authorized. Re-insert seat_a's two destroyed rows for the settled
-- table (stake_post -10, stake_payout +19) via credit_ledger with documented
-- idem_keys"). The full forensic record is integrity_events kind
-- 'settlement_anomaly' (table 0dca3e39-5eeb-4503-a2c1-373905dceca3), written
-- by the sweep migration alongside 20260813090000.
--
-- WHAT HAPPENED, in one paragraph: the table settled correctly and conserved
-- (verified 2026-08-12T07:15Z: posted 20, paid 19, rake 1, net 0). Three hours
-- later, scripts/devnet/e2e.mjs's reset deleted every ledger row for the
-- harness users — including seat_a's settled stake_post (-10) and the winning
-- stake_payout (+19), net +9 of history. Settlement code was not at fault;
-- durability was. The guards that make this class of deletion impossible
-- follow in their own migrations.
--
-- WHAT THIS RESTORES. The exact two rows, for seat_a
-- 23f62d00-9ee6-4d40-9ce1-e6af2a778c67, under the ORIGINAL idem keys the
-- settlement path would have used (mp_escrow: 'stake:<table>:<seat>';
-- mp_settle: 'payout:<table>:<winner>') — so if anything claiming to be this
-- settlement ever replays, it collides with these rows instead of double-
-- crediting. `mp_table_id` is NULL, deliberately: the mp_tables row was
-- deleted by the sweep, the FK would reject the old id, and the surviving
-- sibling rows (seat_b's post, the house rake) already carry null there for
-- the same reason.
--
-- Via credit_ledger_strict, so the ledger rows and the balances update land
-- in one transaction or not at all — and a silent no-op (idem conflict,
-- meaning someone already ran this) aborts instead of half-applying.
--
-- GUARDED: on a database without the incident note (a fresh environment
-- replaying the migration chain) this is a no-op. The repair belongs only to
-- the database that has the wound.

do $$
declare
  v_gap bigint;
begin
  if not exists (
    select 1 from public.integrity_events
     where kind = 'settlement_anomaly'
       and detail ->> 'table_id' = '0dca3e39-5eeb-4503-a2c1-373905dceca3'
  ) then
    raise notice 'no settlement_anomaly record for 0dca3e39 on this database - nothing to repair';
    return;
  end if;

  if exists (
    select 1 from public.ledger where idem_key in (
      'stake:0dca3e39-5eeb-4503-a2c1-373905dceca3:23f62d00-9ee6-4d40-9ce1-e6af2a778c67',
      'payout:0dca3e39-5eeb-4503-a2c1-373905dceca3:23f62d00-9ee6-4d40-9ce1-e6af2a778c67')
  ) then
    raise notice 'repair rows already present - idempotent skip';
    return;
  end if;

  -- seat_a's stake post, exactly as mp_escrow wrote it on 2026-08-12.
  perform public.credit_ledger_strict(
    '23f62d00-9ee6-4d40-9ce1-e6af2a778c67', 'chips', -10, 'stake_post',
    'stake:0dca3e39-5eeb-4503-a2c1-373905dceca3:23f62d00-9ee6-4d40-9ce1-e6af2a778c67',
    null, null, null);

  -- the winning payout, exactly as mp_settle wrote it (pot 20 - rake 1).
  perform public.credit_ledger_strict(
    '23f62d00-9ee6-4d40-9ce1-e6af2a778c67', 'chips', 19, 'stake_payout',
    'payout:0dca3e39-5eeb-4503-a2c1-373905dceca3:23f62d00-9ee6-4d40-9ce1-e6af2a778c67',
    null, null, null);

  -- The repair must CLOSE the identity, in the same transaction that makes it.
  -- If the books do not balance to zero here, nothing above survives.
  select (select coalesce(sum(delta),0) from public.ledger
           where reason in ('chip_purchase','match_reward'))
       - (select coalesce(sum(delta),0) from public.ledger)
       - public.house_balance()
    into v_gap;
  if v_gap <> 0 then
    raise exception 'repair did not close the identity: gap=% - rolling back', v_gap;
  end if;

  -- Mark the incident record resolved, in the same transaction as the repair.
  update public.integrity_events
     set detail = detail || jsonb_build_object(
       'repaired_at', now(),
       'repaired_by', 'migration 20260813120000_repair_0dca3e39_destroyed_rows, owner-authorized 2026-08-13',
       'system_identity_impact', 'repaired: minted = players + house restored to exact')
   where kind = 'settlement_anomaly'
     and detail ->> 'table_id' = '0dca3e39-5eeb-4503-a2c1-373905dceca3';
end $$;
