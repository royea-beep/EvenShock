-- Ledger durability, part 2 of 4: deleting an account must not destroy its
-- financial history.
--
-- `ledger.user_id` was ON DELETE CASCADE — the Supabase starter default, not
-- a decision anyone made. It meant `delete from auth.users where id = ...`
-- (the dashboard's "delete user" button, a GDPR script, anything) silently
-- took every money row the account ever had, exactly the 0dca3e39 failure
-- shape through a different door.
--
-- RESTRICT, not NO ACTION and not SET NULL:
--   - RESTRICT refuses the user deletion outright while ledger rows exist.
--     The books keep every row; an account with financial history cannot be
--     hard-deleted, full stop.
--   - SET NULL would keep the row but orphan it — sums still conserve, but
--     "whose money was this" becomes unanswerable, which is the question an
--     audit asks first.
--
-- THE ERASURE PATH, for when a real deletion request arrives: anonymise the
-- profile (it carries the wallet address — the only personal data), keep the
-- ledger rows under the now-meaningless uuid. The uuid alone identifies
-- nobody; the financial record stays whole. That path is documented here so
-- the first GDPR request is not handled by weakening this constraint in a
-- hurry.
--
-- Defense in depth with part 1: the BEFORE DELETE trigger would also catch a
-- cascade (row deletes via CASCADE fire row triggers). RESTRICT makes the
-- refusal structural rather than dependent on a trigger nobody may drop.
--
-- NOTED, NOT CHANGED (out of this change's authorized scope):
-- `tos_acceptances.user_id` is still CASCADE — deleting an account destroys
-- the evidence of what they agreed to. Same disease, legal rather than
-- financial. Recorded in the checklist for its own decision.

alter table public.ledger drop constraint ledger_user_id_fkey;
alter table public.ledger add constraint ledger_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete restrict;

comment on constraint ledger_user_id_fkey on public.ledger is
  'RESTRICT, deliberately: an account with financial history cannot be hard-deleted. Erasure = anonymise the profile, keep the rows.';
