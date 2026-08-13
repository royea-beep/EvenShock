-- Ledger durability, part 1 of 4: DELETE on financial history refuses by
-- default, and never happens silently.
--
-- WHY. The 0dca3e39 incident was not a settlement bug — it was a harness
-- reset running `delete from ledger where user_id in (...)` and taking a
-- settled match's payout and stake post with it. RLS never saw it: the reset
-- runs as service role, and service role bypasses RLS by design. The only
-- thing that binds the service role too is a trigger.
--
-- THE DESIGN. Guard EVERY row, on both money tables — not just stake rows.
-- The repaired rows from the incident carry `mp_table_id null` (their table
-- was swept), so any guard keyed on table linkage or reason would leave the
-- exact rows this incident taught us about unprotected. Deleting ANY ledger
-- row rewrites financial history; the difference between reasons is only
-- whether it also breaks minted = players + house.
--
-- THE BYPASS, named and audited. Legitimate deletion exists (devnet harness
-- resets, a future anonymisation path), so the guard is a door with a lock,
-- not a wall:
--
--     set local evenshock.ledger_delete_authorization = '<documented reason>';
--     delete from public.ledger where ...;
--
-- `set local` dies with the transaction, so authorization cannot leak past
-- the statement that needed it. Every authorized deletion writes one
-- integrity_events row per deleted row, carrying the FULL row and the stated
-- reason — deletion becomes possible but never silent, and a future
-- 0dca3e39 forensic starts from a record instead of an absence.
--
-- CONSEQUENCE, intended: the harness resets' bare `.delete()` calls on
-- `ledger` now FAIL. That is the incident not repeating. Part 3 of this
-- series (is_harness) gives the resets a legitimate, guarded path.

alter table public.integrity_events drop constraint if exists integrity_events_kind_check;
alter table public.integrity_events add constraint integrity_events_kind_check
  check (kind in ('commitment_mismatch', 'outcome_disagreement', 'reveal_before_move',
                  'move_changed_after_resolution', 'expired_round_submission',
                  'rate_limited', 'treasury_seat_voided', 'settlement_anomaly',
                  'ledger_row_deleted'));

create or replace function public.ledger_delete_guard()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_auth text;
begin
  -- missing_ok=true: an unset GUC reads as null, not an error.
  v_auth := nullif(current_setting('evenshock.ledger_delete_authorization', true), '');

  if v_auth is null then
    raise exception
      'ledger rows are financial history and do not get deleted: %.% id=% reason=% delta=%. If this deletion is genuinely intended, set local evenshock.ledger_delete_authorization to a documented reason in the same transaction.',
      tg_table_schema, tg_table_name, old.id, old.reason, old.delta
      using errcode = 'P0001';
  end if;

  -- house_ledger rows have no user_id; the jsonb lookup nulls out cleanly.
  insert into public.integrity_events (kind, source, user_id, detail)
  values ('ledger_row_deleted', 'server',
    (to_jsonb(old) ->> 'user_id')::uuid,
    jsonb_build_object(
      'table', tg_table_schema || '.' || tg_table_name,
      'authorization', v_auth,
      'deleted_row', to_jsonb(old),
      'deleted_at', now()
    ));

  return old;
end $$;
revoke all on function public.ledger_delete_guard() from public, anon, authenticated;

comment on function public.ledger_delete_guard() is
  'BEFORE DELETE on ledger and house_ledger. Refuses unless evenshock.ledger_delete_authorization is set locally to a reason; audits every authorized deletion with the full row. Binds the service role too — that is the point.';

drop trigger if exists ledger_no_silent_delete on public.ledger;
create trigger ledger_no_silent_delete
  before delete on public.ledger
  for each row execute function public.ledger_delete_guard();

drop trigger if exists house_ledger_no_silent_delete on public.house_ledger;
create trigger house_ledger_no_silent_delete
  before delete on public.house_ledger
  for each row execute function public.ledger_delete_guard();
