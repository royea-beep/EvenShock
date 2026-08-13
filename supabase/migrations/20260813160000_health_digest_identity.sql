-- Ledger durability, part 4 of 4: the system identity, watched, not assumed.
--
-- minted = players + house is the one-line statement that no chip exists
-- outside the books: everything ever created (chip purchases + match rewards)
-- is either in a player's ledger or in the house's. The 0dca3e39 incident sat
-- at gap = 9 for a full day before anyone computed it, because nothing
-- computed it. Now the owner's daily digest does, every time.
--
-- CHIPS ONLY, explicitly. XP is also minted through 'match_reward' rows, and
-- because XP is never spent or raked it cancels out of the all-currency sums —
-- the gap comes out identical either way on today's data. But "identical by
-- cancellation" is a coincidence of XP having no sinks, and the identity is a
-- claim about CHIPS. Stating the currency makes the check mean what the
-- checklist says, and keeps it meaning that on the day XP grows a sink.
--
-- Alongside it: per-table conservation breaches (mp_conservation_check with
-- conserved = false) and the existing balances-vs-ledger drift count. Three
-- different failures: a table that leaked mid-settlement, a cached balance
-- that diverged from its rows, and a system-wide creation/holdings mismatch.
-- Any of them nonzero is a stop-the-line number.

create or replace function public.health_digest(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_rows jsonb;
  v_minted bigint;
  v_players bigint;
  v_house bigint;
begin
  if not public.take_rate_token(p_user_id, 'health') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  if not exists (select 1 from public.profiles where id = p_user_id and is_owner) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', kind, 'source', source, 'events', events, 'users', users, 'latest', latest
         )), '[]'::jsonb)
    into v_rows
    from public.integrity_summary('24 hours');

  select coalesce(sum(delta), 0) into v_minted
    from public.ledger
   where currency = 'chips' and reason in ('chip_purchase', 'match_reward');
  select coalesce(sum(delta), 0) into v_players
    from public.ledger where currency = 'chips';
  v_house := public.house_balance();

  return jsonb_build_object(
    'window', '24 hours',
    'events', v_rows,
    'money', jsonb_build_object(
      'minted',       v_minted,
      'players',      v_players,
      'house',        v_house,
      'identity_gap', v_minted - v_players - v_house,
      'identity_ok',  (v_minted - v_players - v_house) = 0,
      'conservation_breaches',
        (select count(*) from public.mp_conservation_check() where not conserved)
    ),
    'totals', jsonb_build_object(
      'matches_complete',   (select count(*) from public.matches where status = 'complete'),
      'matches_abandoned',  (select count(*) from public.matches where status = 'in_progress'),
      'players',            (select count(*) from public.profiles),
      'ledger_mismatches',  (
        select count(*) from (
          select b.user_id
            from public.balances b
            left join (
              select user_id,
                     sum(delta) filter (where currency = 'xp')    as xp,
                     sum(delta) filter (where currency = 'chips') as chips
                from public.ledger group by user_id
            ) l on l.user_id = b.user_id
           where b.xp <> coalesce(l.xp, 0) or b.chips <> coalesce(l.chips, 0)
        ) m
      )
    )
  );
end $$;
-- Deployed posture preserved: executable by service_role only (the Edge
-- Function calls it and passes the verified JWT's user id; the is_owner check
-- inside is the second lock). No grant to authenticated — that would be new
-- surface this change has no business adding.
revoke all on function public.health_digest(uuid) from public, anon, authenticated;
