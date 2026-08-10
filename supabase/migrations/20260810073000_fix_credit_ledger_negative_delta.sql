-- credit_ledger could not record a negative amount.
--
-- It moved the balance with INSERT ... ON CONFLICT DO UPDATE. Postgres checks
-- constraints against the PROPOSED INSERT TUPLE before the conflict is
-- resolved, so for an existing player a delta of -20 was checked as a brand new
-- row containing -20, tripped `balances_chips_check`, and aborted — even though
-- the update branch would have produced a perfectly legal 60.
--
-- Nothing in the live paths hit it: awards are positive and spend_chips does
-- its own conditional UPDATE. It surfaced while trimming a test balance, which
-- is a lucky place to find it, because the operation it blocks is the one an
-- append-only ledger exists to support. A ledger you cannot post a correction
-- to is a log, not a ledger — and the first time that matters will be the day a
-- player is wrongly charged.
--
-- Seed-then-update instead: the constraint is then only ever evaluated against
-- the row that will actually be stored.

create or replace function public.credit_ledger(
  p_user_id  uuid,
  p_currency text,
  p_delta    bigint,
  p_reason   text,
  p_idem_key text,
  p_match_id uuid default null,
  p_sku      text default null
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ledger_id bigint;
  v_balance   bigint;
begin
  if p_delta = 0 then return null; end if;

  -- The ledger row is claimed FIRST, before any balance moves. Two concurrent
  -- identical credits both reach here; the unique index lets exactly one
  -- through and the other gets no row back, so the balance moves once. Doing
  -- this the other way round — move the balance, then try to record it — is how
  -- double-credits happen.
  insert into public.ledger (user_id, currency, delta, reason, match_id, sku, idem_key, balance_after)
  values (p_user_id, p_currency, p_delta, p_reason, p_match_id, p_sku, p_idem_key, 0)
  on conflict (idem_key) do nothing
  returning id into v_ledger_id;

  if v_ledger_id is null then
    return null; -- already credited; nothing to do
  end if;

  -- Seed, then update. Two statements rather than an upsert precisely so the
  -- >= 0 check is evaluated against the final row and not against a proposed
  -- insert that was never going to be stored.
  insert into public.balances (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  update public.balances
     set xp    = xp    + case when p_currency = 'xp'    then p_delta else 0 end,
         chips = chips + case when p_currency = 'chips' then p_delta else 0 end,
         updated_at = now()
   where user_id = p_user_id
  returning case when p_currency = 'xp' then xp else chips end into v_balance;

  update public.ledger set balance_after = v_balance where id = v_ledger_id;
  return v_balance;
end $$;

revoke all on function public.credit_ledger(uuid, text, bigint, text, text, uuid, text)
  from public, anon, authenticated;
