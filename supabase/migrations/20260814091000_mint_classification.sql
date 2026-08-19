-- The conservation identity had an enumerated allow-list, and the daily streak
-- fell straight through it.
--
-- `minted` was defined in two places as `reason in ('chip_purchase',
-- 'match_reward')`, while `players` sums EVERY chip delta. So any new way of
-- creating chips inflates `players` without inflating `minted`, and the
-- identity `minted = players + house` opens by exactly the amount created.
-- Caught by proving the streak rather than trusting it: identity_ok went false
-- with gap -1 on the first bonus chip.
--
-- This is the same failure shape as `geo_refused` missing from the
-- integrity_events CHECK constraint — a hand-maintained list that nothing
-- forces you to register in, failing silently in the direction of looking
-- fine. So the fix is not "add one more string to two lists".
--
-- MINT CLASSIFICATION BECOMES DATA. Every ledger reason is classified once,
-- in one table, and both conservation checks read it. Adding a reason without
-- classifying it is now detectable — `ledger_reasons_unclassified()` returns
-- it — instead of silently breaking the identity.

create table if not exists public.ledger_reason_kinds (
  reason text primary key,
  mints  boolean not null,
  note   text    not null
);
alter table public.ledger_reason_kinds enable row level security;
revoke all on public.ledger_reason_kinds from anon, authenticated;

comment on table public.ledger_reason_kinds is
  'Does this ledger reason CREATE chips, or only move them? `mints` true means '
  'the chips came from nowhere and must be counted in the minted total; false '
  'means they moved between a player and the house, which nets to zero across '
  'the identity. Read by health_digest and tournament_conservation_check.';

insert into public.ledger_reason_kinds (reason, mints, note) values
  ('chip_purchase',     true,  'Bought with USDC. New chips enter the system.'),
  ('match_reward',      true,  'Earned by completing a match. New chips.'),
  ('daily_streak',      true,  'Daily return bonus. New chips, capped per day.'),
  ('theme_unlock',      false, 'Spent on a cosmetic. Chips leave the player and are burned, not moved to the house.'),
  ('stake_post',        false, 'Player to escrow. A move, not a mint.'),
  ('stake_payout',      false, 'Escrow to winner. A move.'),
  ('stake_refund',      false, 'Escrow back to player. A move.'),
  ('tournament_entry',  false, 'Player to pool. A move.'),
  ('tournament_prize',  false, 'Pool to winner. A move.'),
  ('tournament_refund', false, 'Pool back to entrant. A move.')
on conflict (reason) do nothing;

-- The single definition of what has been minted. Both conservation checks call
-- this rather than restating the list.
create or replace function public.chips_minted()
returns bigint
language sql stable security definer set search_path to '' as $$
  select coalesce(sum(l.delta), 0)::bigint
    from public.ledger l
    join public.ledger_reason_kinds k on k.reason = l.reason and k.mints
   where l.currency = 'chips';
$$;
revoke all on function public.chips_minted() from public, anon, authenticated;

-- The guard. Any reason the ledger permits or contains but nobody has
-- classified. Should always be empty; anything here silently breaks the
-- identity the moment it is used.
create or replace function public.ledger_reasons_unclassified()
returns table (reason text, source text)
language sql stable security definer set search_path to '' as $$
  select r.reason, r.source from (
    select distinct l.reason, 'in use'::text as source from public.ledger l
    union
    select trim(both '''' from replace(x, '::text', '')), 'permitted by constraint'
      from pg_constraint,
           lateral regexp_split_to_table(
             substring(pg_get_constraintdef(oid) from 'ARRAY\[(.*)\]'), ',\s*') as x
     where conname = 'ledger_reason_check'
  ) r
  where not exists (select 1 from public.ledger_reason_kinds k where k.reason = r.reason)
  order by r.reason;
$$;
revoke all on function public.ledger_reasons_unclassified() from public, anon, authenticated;

comment on function public.ledger_reasons_unclassified() is
  'Ledger reasons in use or permitted but not classified as minting or moving. '
  'Must return zero rows — an unclassified reason opens the conservation '
  'identity by exactly the amount it moves, silently. Add a row to '
  'ledger_reason_kinds rather than widening a list in a function.';

-- ------------------------------------------------- both consumers, re-emitted
-- Only the `minted` expression changes in each. Everything else is carried
-- over unchanged.

create or replace function public.health_digest(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path to '' as $function$
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

  v_minted := public.chips_minted();
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
        (select count(*) from public.mp_conservation_check() where not conserved),
      -- Surfaced next to the identity it protects: a non-empty list here means
      -- the identity is about to be wrong, or already is.
      'unclassified_reasons',
        (select count(*) from public.ledger_reasons_unclassified())
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
end $function$;

create or replace function public.tournament_conservation_check(p_tournament_id uuid)
returns jsonb
language sql stable security definer set search_path to '' as $$
  with entries_in as (
    select coalesce(-sum(delta), 0) as amount from public.ledger
     where reason = 'tournament_entry'
       and idem_key like 'tentry:' || p_tournament_id::text || ':%'
  ),
  prizes_out as (
    select coalesce(sum(delta), 0) as amount from public.ledger
     where reason in ('tournament_prize', 'tournament_refund')
       and (idem_key like 'tprize:' || p_tournament_id::text || ':%'
         or idem_key like 'trefund:' || p_tournament_id::text || ':%')
  ),
  house_in as (
    select coalesce(sum(delta), 0) as amount from public.house_ledger
     where reason = 'tournament_pool'
       and idem_key like 'tpool:' || p_tournament_id::text || ':%'
  ),
  house_out as (
    select coalesce(-sum(delta), 0) as amount from public.house_ledger
     where reason in ('tournament_payout', 'tournament_refund')
       and (idem_key like 'tpayout:' || p_tournament_id::text || ':%'
         or idem_key like 'trefund:' || p_tournament_id::text || ':%')
  ),
  identity as (
    select public.chips_minted() as minted,
           (select coalesce(sum(delta), 0) from public.ledger where currency = 'chips') as players,
           public.house_balance() as house
  )
  select jsonb_build_object(
    'tournament_id',  p_tournament_id,
    'entries_in',     e.amount,
    'house_in',       hi.amount,
    'prizes_out',     p.amount,
    'house_out',      ho.amount,
    'undistributed',  e.amount - p.amount,
    'entries_match_house', e.amount = hi.amount,
    'prizes_match_house',  p.amount = ho.amount,
    'no_overpay',          p.amount <= e.amount,
    'global_minted',  i.minted,
    'global_players', i.players,
    'global_house',   i.house,
    'identity_gap',   i.minted - i.players - i.house,
    'conserved',      e.amount = hi.amount
                      and p.amount = ho.amount
                      and p.amount <= e.amount
                      and (i.minted - i.players - i.house) = 0
  )
  from entries_in e, prizes_out p, house_in hi, house_out ho, identity i;
$$;
revoke all on function public.tournament_conservation_check(uuid) from public, anon, authenticated;
