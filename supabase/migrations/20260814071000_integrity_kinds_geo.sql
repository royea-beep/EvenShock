-- The geo integrity events were never recordable, and nothing said so.
--
-- `integrity_events.kind` carries a CHECK constraint listing every permitted
-- kind. Neither `geo_refused` — written when the geo gate was built — nor
-- `geo_bypassed` — added with the master switch — was in that list. And
-- `log_integrity_event` ends with `exception when others then null`, so the
-- constraint violation was swallowed and the call looked like it worked.
--
-- The result: every geographic refusal this system has ever made went
-- unrecorded, and the compliance story rested on a log that was empty for the
-- wrong reason. Found by probing the insert directly rather than by trusting
-- that a `perform log_integrity_event(...)` line means an event exists.
--
-- THE SWALLOW STAYS. It is correct: logging is best-effort by design, on a
-- path that is already going wrong, and a failed write must not turn a refusal
-- into a 500. What was missing is not error propagation — it is a way to
-- notice, which is what `integrity_kinds_unlogged()` below provides.

alter table public.integrity_events drop constraint if exists integrity_events_kind_check;
alter table public.integrity_events add constraint integrity_events_kind_check
  check (kind = any (array[
    'commitment_mismatch',
    'outcome_disagreement',
    'reveal_before_move',
    'move_changed_after_resolution',
    'expired_round_submission',
    'rate_limited',
    'treasury_seat_voided',
    'settlement_anomaly',
    'ledger_row_deleted',
    'collusion_suspected',
    'rating_farming',
    'self_play_suspected',
    'tournament_conservation_breach',
    'skill_update_failed',
    -- A purchase refused on geography. Should have been recordable from the
    -- day the gate was written.
    'geo_refused',
    -- A purchase that only succeeded because the geo_blocking master switch
    -- was off. The question after switching it back on is "what got through",
    -- and this is the row that answers it.
    'geo_bypassed'
  ]));

-- ------------------------------------------------------- how to notice next
-- Compares the kinds the code actually emits against the kinds the constraint
-- permits. Anything it returns is an event that silently never happens.
--
-- Reads function bodies rather than a hand-maintained list, so a kind added to
-- code in future is checked without anyone remembering to register it here —
-- the same reason the harness wallet registry is generated rather than typed.
create or replace function public.integrity_kinds_unlogged()
returns table (kind text)
language sql stable security definer set search_path to '' as $$
  with emitted as (
    select distinct (regexp_matches(pg_get_functiondef(oid),
      'log_integrity_event\(\s*[^,]+,\s*''([a-z_]+)''', 'g'))[1] as kind
      from pg_proc where pronamespace = 'public'::regnamespace
  ),
  allowed as (
    select trim(both '''' from replace(x, '::text', '')) as kind
      from pg_constraint,
           lateral regexp_split_to_table(
             substring(pg_get_constraintdef(oid) from 'ARRAY\[(.*)\]'), ',\s*') as x
     where conname = 'integrity_events_kind_check'
  )
  select e.kind from emitted e
   where e.kind not in (select a.kind from allowed a)
   order by e.kind;
$$;
revoke all on function public.integrity_kinds_unlogged() from public, anon, authenticated;

comment on function public.integrity_kinds_unlogged() is
  'Kinds emitted by code but rejected by the integrity_events CHECK constraint '
  '— i.e. events that are silently dropped because log_integrity_event '
  'swallows the violation. Should always return zero rows. Two kinds '
  '(geo_refused, geo_bypassed) sat here unnoticed until 2026-08-14.';

-- ------------------------------------------- the flag's own birth, recorded
-- 20260814070000 inserted the geo_blocking row BEFORE creating the audit
-- trigger, so the flag's creation left no audit row — the trail began at the
-- first flip. That file has been reordered for fresh environments; this
-- backfills the environments that already ran the original order.
--
-- Marked as a backfill in changed_role rather than dressed up as an observed
-- event: an audit trail that quietly contains reconstructed rows is worse than
-- one with a visible gap.
insert into public.feature_flag_audit (key, old_enabled, new_enabled, reason, changed_role, changed_at)
select 'geo_blocking', null, true,
       'Flag created ON by migration 20260814070000.',
       'backfill:20260814071000',
       (select min(changed_at) from public.feature_flag_audit where key = 'geo_blocking')
 where exists (select 1 from public.feature_flags where key = 'geo_blocking')
   and not exists (
     select 1 from public.feature_flag_audit
      where key = 'geo_blocking' and old_enabled is null);
