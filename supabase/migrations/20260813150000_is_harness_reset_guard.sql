-- Ledger durability, part 3 of 4: harness resets get one sanctioned door,
-- and it refuses to open on anyone whose history touches another person.
--
-- THE INCIDENT, one more time: e2e.mjs's reset ran
-- `delete from ledger where user_id in (harness users)` and took a settled
-- stake match's rows with it — because the harness user had PLAYED A REAL
-- OPPONENT, and "everything this user ever did" included half of someone
-- else's financial history. The reset was correct for a user whose rows are
-- all self-contained (bot rewards, test purchases) and destructive the moment
-- they weren't. Part 1's trigger already blocks the bare delete; this part
-- gives the harness its legitimate path back, with the entanglement check the
-- original never had.
--
-- 1. `profiles.is_harness` — a fact about the account, stored on the account.
--    Scripts asserting "this is a throwaway" stop being the authority on it.
-- 2. `harness_reset_user(uuid)` — service-role-only RPC, the ONLY sanctioned
--    way to reset a harness user. It refuses:
--      - any user not marked is_harness (a typo'd uuid resets nobody);
--      - any user with stake-reason ledger rows — shared financial history,
--        and reason-keyed rather than table-keyed because the 0dca3e39 rows
--        survive their table's sweep with mp_table_id null;
--      - any user with multiplayer table history (seats or receipts) — same
--        entanglement one step earlier.
--    It sets the part-1 delete authorization itself, transaction-locally, so
--    its deletes are audited: integrity_events is cleared FIRST, then the
--    ledger deletes write fresh audit rows that survive as the record of the
--    reset.
--
-- A harness user who has sat at a stake table is therefore UNRESETTABLE.
-- Intended: that user's rows are half of an opponent's history, and the fix
-- for "my test account is dirty" is a new test account, never someone else's
-- books.

alter table public.profiles
  add column if not exists is_harness boolean not null default false;

comment on column public.profiles.is_harness is
  'Throwaway harness account: harness_reset_user() will wipe it (unless entangled with another user''s history). Never set on a real player.';

-- The two devnet harness keypairs. On a database where they do not exist
-- (fresh environment) this updates zero rows, which is correct.
update public.profiles set is_harness = true
 where id in ('23f62d00-9ee6-4d40-9ce1-e6af2a778c67',
              'c8110228-4267-4f03-802e-fc2eb0b0e1ac');

create or replace function public.harness_reset_user(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_harness boolean;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
begin
  select is_harness into v_harness from public.profiles where id = p_user_id;
  if v_harness is distinct from true then
    raise exception 'harness_reset_user refused: % is not marked is_harness', p_user_id
      using errcode = 'P0001';
  end if;

  if exists (select 1 from public.ledger
              where user_id = p_user_id
                and reason in ('stake_post', 'stake_payout', 'stake_refund')) then
    raise exception 'harness_reset_user refused: % has stake ledger rows - that is shared financial history, half of it belongs to an opponent. Use a fresh harness account.', p_user_id
      using errcode = 'P0001';
  end if;

  if exists (select 1 from public.mp_tables where seat_a = p_user_id or seat_b = p_user_id)
     or exists (select 1 from public.mp_receipts where user_id = p_user_id) then
    raise exception 'harness_reset_user refused: % has multiplayer table history. Use a fresh harness account.', p_user_id
      using errcode = 'P0001';
  end if;

  -- Authorize this transaction's ledger deletes through the part-1 guard.
  -- `set local` scope: authorization dies with this transaction.
  perform set_config('evenshock.ledger_delete_authorization',
    'harness_reset_user(' || p_user_id::text || ')', true);

  -- integrity_events first: the ledger deletes below write fresh audit rows
  -- for this user, and clearing afterwards would erase the reset's own record.
  delete from public.integrity_events where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('integrity_events', v_n);

  delete from public.rounds where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('rounds', v_n);

  delete from public.matches where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('matches', v_n);

  delete from public.ledger where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('ledger', v_n);

  delete from public.payments where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('payments', v_n);

  delete from public.payment_intents where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('payment_intents', v_n);

  delete from public.inventory where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('inventory', v_n);

  delete from public.tos_acceptances where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('tos_acceptances', v_n);

  delete from public.balances where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('balances', v_n);

  return jsonb_build_object('ok', true, 'user', p_user_id, 'deleted', v_counts);
end $$;
revoke all on function public.harness_reset_user(uuid) from public, anon, authenticated;

comment on function public.harness_reset_user(uuid) is
  'The only sanctioned reset for harness accounts. Refuses non-harness users and any user with stake or multiplayer history (entangled with an opponent''s books). Deletes are audited via the part-1 guard.';
