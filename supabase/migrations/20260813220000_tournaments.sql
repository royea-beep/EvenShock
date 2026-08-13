-- Skill layer, part 6 of the EVENSHOCK-SKILL-LAYER brief: tournaments.
--
-- CHIPS ONLY. Nothing here reads or writes the stake_tables flag.
--
-- HOW THE MONEY MOVES, AND WHY IT NEVER OPENS A HOLE
--
-- The identity health_digest asserts is: minted = players + house, where
-- minted counts only chip_purchase and match_reward. A tournament mints
-- nothing, so both new reasons stay outside that set and the left-hand side
-- never moves. The right-hand side is kept balanced by pairing every player
-- movement with an equal and opposite house movement, in the SAME transaction:
--
--   register:  player -fee   (ledger 'tournament_entry')
--              house  +fee   (house_ledger 'tournament_pool')
--   settle:    winners +prize (ledger 'tournament_prize')
--              house   -prize (house_ledger 'tournament_payout')
--
-- The pool therefore sits INSIDE the house while the tournament runs. That is
-- the whole trick: an escrow account that is not part of the identity would
-- show up as a hole in the books for the entire duration of the event, and
-- nobody could tell that hole apart from the real one this project already had
-- (the 0dca3e39 settlement anomaly, repaired by 20260813120000). Here there is
-- no moment at which the books do not balance.
--
-- WHY THE TOURNAMENT ID LIVES IN idem_key AND NOT A NEW COLUMN
--
-- The ledger already carries match_id and mp_table_id, so a tournament_id
-- column would be the obvious next step. It was rejected: credit_ledger cannot
-- gain a parameter without CREATE OR REPLACE refusing the signature change,
-- which means an overload — and this project has already been burned by
-- exactly that (see drop_credit_ledger_overload). Dropping and recreating the
-- one function every money path in the system goes through, to add a reporting
-- column, is not a trade worth making. idem_key is already structured
-- ('payout:<id>:<uid>', 'reward:<id>:xp') and already unique, so tournament
-- rows are keyed 'tentry:<tid>:<uid>' and found by prefix. The format is
-- load-bearing for the conservation check and is asserted by it.

-- The vocabulary. Both new player reasons stay out of the minted set on
-- purpose — see the header.
alter table public.ledger drop constraint if exists ledger_reason_check;
alter table public.ledger add constraint ledger_reason_check
  check (reason in ('match_reward', 'theme_unlock', 'chip_purchase',
                    'stake_post', 'stake_payout', 'stake_refund',
                    'tournament_entry', 'tournament_prize', 'tournament_refund'));

alter table public.house_ledger drop constraint if exists house_ledger_reason_check;
alter table public.house_ledger add constraint house_ledger_reason_check
  check (reason in ('rake', 'tournament_pool', 'tournament_payout', 'tournament_refund'));

-- ------------------------------------------------------------ house movement
-- The insert-then-backfill-balance_after dance from mp_settle, in one place.
-- It raises rather than returning null when the row does not land, for the
-- same reason credit_ledger_strict does: a house movement that silently did
-- not happen is how a pot goes missing.
create or replace function public.house_credit(
  p_delta bigint, p_reason text, p_idem_key text
) returns bigint
language plpgsql security definer set search_path to '' as $$
declare v_balance bigint;
begin
  if p_delta = 0 then return public.house_balance(); end if;

  insert into public.house_ledger (delta, reason, table_id, idem_key, balance_after)
  values (p_delta, p_reason, null, p_idem_key, 0)
  on conflict (idem_key) do nothing;

  if not found then
    raise exception 'house movement did not land: reason=% delta=% idem=%',
      p_reason, p_delta, p_idem_key using errcode = 'P0001';
  end if;

  select public.house_balance() into v_balance;
  update public.house_ledger set balance_after = v_balance where idem_key = p_idem_key;
  return v_balance;
end $$;
revoke all on function public.house_credit(bigint, text, text) from public, anon, authenticated;

-- --------------------------------------------------------------- the bracket
-- Standard single-elimination seeding order, built by the usual doubling
-- recurrence: order(2n) interleaves order(n) with its complement. This is what
-- puts seeds 1 and 2 on opposite halves so they can only meet in the final.
-- The naive "1 plays 8, 2 plays 7, ..." in slot order does NOT do that — it
-- pairs 1 against 2 in the semi-final — which is the bug this function exists
-- to avoid.
create or replace function public.tournament_seed_order(p_size int)
returns int[]
language plpgsql immutable parallel safe as $$
declare
  v_order int[] := array[1];
  v_next  int[];
  v_n     int := 1;
  i       int;
begin
  while v_n < p_size loop
    v_next := array[]::int[];
    for i in 1..v_n loop
      v_next := v_next || v_order[i] || (2 * v_n + 1 - v_order[i]);
    end loop;
    v_order := v_next;
    v_n := v_n * 2;
  end loop;
  return v_order;
end $$;
comment on function public.tournament_seed_order(int) is
  'Bracket positions for a single-elimination draw of p_size. Seeds 1 and 2 '
  'land in opposite halves. tournament_seed_order(8) = {1,8,4,5,2,7,3,6}.';

-- ---------------------------------------------------------------- lifecycle
create or replace function public.tournament_create(
  p_name text,
  p_entry_fee_chips bigint default 0,
  p_max_players int default 8,
  p_format text default 'bo5',
  p_starts_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_id uuid;
begin
  insert into public.tournaments (name, format, entry_fee_chips, max_players, status,
                                  season_id, starts_at)
  values (p_name, p_format, p_entry_fee_chips, p_max_players, 'registering',
          (select id from public.seasons where status = 'active' order by starts_at desc limit 1),
          p_starts_at)
  returning id into v_id;
  return jsonb_build_object('tournament_id', v_id, 'status', 'registering');
end $$;
revoke all on function public.tournament_create(text, bigint, int, text, timestamptz)
  from public, anon, authenticated;

create or replace function public.tournament_register(p_tournament_id uuid, p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  t public.tournaments;
  v_count int;
  v_balance bigint;
begin
  select * into t from public.tournaments where id = p_tournament_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if t.status <> 'registering' then
    return jsonb_build_object('error', 'not_registering', 'status', t.status);
  end if;

  -- A harness or owner account entering a chip tournament is rating farming
  -- with a prize attached. Same gate as the ladder, same function.
  if not public.is_rateable_player(p_user_id) then
    return jsonb_build_object('error', 'unrateable_player');
  end if;

  if exists (select 1 from public.tournament_entries
              where tournament_id = t.id and user_id = p_user_id) then
    return jsonb_build_object('error', 'already_entered');
  end if;

  select count(*) into v_count from public.tournament_entries where tournament_id = t.id;
  if v_count >= t.max_players then
    return jsonb_build_object('error', 'full');
  end if;

  if t.entry_fee_chips > 0 then
    select chips into v_balance from public.balances where user_id = p_user_id;
    if coalesce(v_balance, 0) < t.entry_fee_chips then
      return jsonb_build_object('error', 'insufficient_chips',
                                'need', t.entry_fee_chips, 'have', coalesce(v_balance, 0));
    end if;

    -- Player out, house in, same transaction. Neither can happen alone.
    perform public.credit_ledger_strict(
      p_user_id, 'chips', -t.entry_fee_chips, 'tournament_entry',
      'tentry:' || t.id::text || ':' || p_user_id::text);
    perform public.house_credit(
      t.entry_fee_chips, 'tournament_pool',
      'tpool:' || t.id::text || ':' || p_user_id::text);
  end if;

  insert into public.tournament_entries (tournament_id, user_id) values (t.id, p_user_id);

  update public.tournaments
     set prize_pool_chips = prize_pool_chips + t.entry_fee_chips
   where id = t.id;

  return jsonb_build_object('ok', true, 'tournament_id', t.id, 'entered', v_count + 1);
end $$;
revoke all on function public.tournament_register(uuid, uuid) from public, anon, authenticated;

-- Seeds by current rating and draws the bracket.
create or replace function public.tournament_start(p_tournament_id uuid)
returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  t        public.tournaments;
  v_n      int;
  v_size   int := 1;
  v_rounds int;
  v_order  int[];
  v_a      uuid;
  v_b      uuid;
  j        int;
  r        int;
  v_byes   int := 0;
begin
  select * into t from public.tournaments where id = p_tournament_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if t.status <> 'registering' then
    return jsonb_build_object('error', 'not_registering', 'status', t.status);
  end if;

  select count(*) into v_n from public.tournament_entries where tournament_id = t.id;
  if v_n < 2 then return jsonb_build_object('error', 'not_enough_players', 'entered', v_n); end if;

  -- Seed 1 is the strongest. Unrated entrants sit at the 1500 default, which
  -- is the honest place for "we do not know yet" rather than last.
  with ranked as (
    select e.user_id,
           row_number() over (
             order by coalesce(pr.rating, 1500) desc,
                      coalesce(pr.rating_deviation, 350) asc,
                      e.registered_at asc
           ) as seed
      from public.tournament_entries e
      left join public.player_ratings pr on pr.user_id = e.user_id
     where e.tournament_id = t.id
  )
  update public.tournament_entries e
     set seed = ranked.seed
    from ranked
   where e.tournament_id = t.id and e.user_id = ranked.user_id;

  -- Bracket size is the smallest power of two that fits the entrants, NOT
  -- max_players. max_players is the registration cap; sizing the draw by it
  -- would put two byes in one slot and produce a match with nobody in it.
  while v_size < v_n loop v_size := v_size * 2; end loop;
  v_rounds := 0;
  for j in 1..16 loop
    exit when 2 ^ j > v_size;
    v_rounds := j;
  end loop;

  v_order := public.tournament_seed_order(v_size);

  -- Every slot of every round up front, so the bracket is a complete object
  -- that can be rendered before a single result exists.
  for r in 1..v_rounds loop
    for j in 1..(v_size / (2 ^ r))::int loop
      insert into public.tournament_matches (tournament_id, round_no, slot, status)
      values (t.id, r, j, 'pending')
      on conflict (tournament_id, round_no, slot) do nothing;
    end loop;
  end loop;

  for j in 1..(v_size / 2) loop
    select user_id into v_a from public.tournament_entries
      where tournament_id = t.id and seed = v_order[2 * j - 1];
    select user_id into v_b from public.tournament_entries
      where tournament_id = t.id and seed = v_order[2 * j];

    update public.tournament_matches
       set player_a = v_a, player_b = v_b,
           status   = case when v_a is null or v_b is null then 'bye' else 'pending' end,
           winner   = case when v_b is null then v_a
                           when v_a is null then v_b end
     where tournament_id = t.id and round_no = 1 and slot = j;

    -- A bye is already decided, so it advances immediately. Byes can never
    -- collide: the bracket is the smallest power of two >= n, so fewer than
    -- half the seeds are missing and standard seeding puts each of them in a
    -- different slot.
    if v_a is null or v_b is null then
      v_byes := v_byes + 1;
      perform public.tournament_advance(t.id, 1, j, coalesce(v_a, v_b), v_rounds);
    end if;
  end loop;

  update public.tournaments set status = 'running' where id = t.id;

  return jsonb_build_object('ok', true, 'tournament_id', t.id, 'entrants', v_n,
                            'bracket_size', v_size, 'rounds', v_rounds, 'byes', v_byes);
end $$;
revoke all on function public.tournament_start(uuid) from public, anon, authenticated;

-- Moves a winner into their next slot. Separate from reporting because byes
-- use it too, at draw time, before any match has been played.
create or replace function public.tournament_advance(
  p_tournament_id uuid, p_round_no int, p_slot int, p_winner uuid, p_rounds int
) returns void
language plpgsql security definer set search_path to '' as $$
declare v_next_slot int;
begin
  if p_round_no >= p_rounds or p_winner is null then return; end if;
  v_next_slot := ((p_slot + 1) / 2)::int;
  if p_slot % 2 = 1 then
    update public.tournament_matches set player_a = p_winner
     where tournament_id = p_tournament_id and round_no = p_round_no + 1 and slot = v_next_slot;
  else
    update public.tournament_matches set player_b = p_winner
     where tournament_id = p_tournament_id and round_no = p_round_no + 1 and slot = v_next_slot;
  end if;
end $$;
revoke all on function public.tournament_advance(uuid, int, int, uuid, int) from public, anon, authenticated;

create or replace function public.tournament_report_result(
  p_tournament_id uuid, p_round_no int, p_slot int,
  p_winner uuid, p_mp_table_id uuid default null
) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  m       public.tournament_matches;
  v_rounds int;
begin
  select * into m from public.tournament_matches
   where tournament_id = p_tournament_id and round_no = p_round_no and slot = p_slot
     for update;
  if not found then return jsonb_build_object('error', 'no_such_slot'); end if;
  if m.status = 'complete' then
    return jsonb_build_object('error', 'already_reported', 'winner', m.winner);
  end if;
  if m.player_a is null or m.player_b is null then
    return jsonb_build_object('error', 'slot_not_ready');
  end if;
  if p_winner is distinct from m.player_a and p_winner is distinct from m.player_b then
    return jsonb_build_object('error', 'winner_not_in_slot');
  end if;

  select max(round_no) into v_rounds from public.tournament_matches
   where tournament_id = p_tournament_id;

  update public.tournament_matches
     set winner = p_winner, status = 'complete', mp_table_id = p_mp_table_id
   where tournament_id = p_tournament_id and round_no = p_round_no and slot = p_slot;

  perform public.tournament_advance(p_tournament_id, p_round_no, p_slot, p_winner, v_rounds);

  return jsonb_build_object('ok', true, 'round', p_round_no, 'slot', p_slot, 'winner', p_winner);
end $$;
revoke all on function public.tournament_report_result(uuid, int, int, uuid, uuid)
  from public, anon, authenticated;

-- ------------------------------------------------------- conservation check
-- Two questions, both of which have to be yes:
--   1. Does this tournament's own money balance — did every chip taken from a
--      player reach the house, and every chip paid out leave it?
--   2. Does the GLOBAL identity still hold? A tournament that balanced
--      internally while breaking minted = players + house would still be a
--      breach, and only the second question catches that.
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
    select (select coalesce(sum(delta), 0) from public.ledger
             where currency = 'chips' and reason in ('chip_purchase', 'match_reward')) as minted,
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

-- ------------------------------------------------------------------ settle
-- PAYOUT STRUCTURE: first and second only, 65/35, with any rounding remainder
-- going to the champion.
--
-- Deeper structures were considered and rejected for now. In a single
-- elimination draw only positions 1 and 2 are unique — everyone else ties with
-- whoever else went out in the same round, and paying a tied position means
-- inventing a tie-break or splitting a share that may not divide evenly. Both
-- of those create chips or destroy them at the rounding boundary unless
-- handled very carefully, and an exactly-conservative payout to two unique
-- positions is worth more than a prettier prize table that can leak a chip.
-- Giving the remainder to first place is what makes the sum exact by
-- construction rather than by luck.
create or replace function public.tournament_settle(p_tournament_id uuid)
returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  t        public.tournaments;
  v_rounds int;
  v_final  public.tournament_matches;
  v_champ  uuid;
  v_runner uuid;
  v_pool   bigint;
  v_second bigint;
  v_first  bigint;
  v_check  jsonb;
begin
  select * into t from public.tournaments where id = p_tournament_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if t.status = 'complete' then
    return jsonb_build_object('ok', true, 'already_settled', true);
  end if;
  if t.status <> 'running' then
    return jsonb_build_object('error', 'not_running', 'status', t.status);
  end if;

  select max(round_no) into v_rounds from public.tournament_matches where tournament_id = t.id;
  select * into v_final from public.tournament_matches
   where tournament_id = t.id and round_no = v_rounds and slot = 1;

  if v_final.status <> 'complete' or v_final.winner is null then
    return jsonb_build_object('error', 'final_not_played');
  end if;
  if exists (select 1 from public.tournament_matches
              where tournament_id = t.id and status = 'pending') then
    return jsonb_build_object('error', 'bracket_incomplete');
  end if;

  v_champ  := v_final.winner;
  v_runner := case when v_final.winner = v_final.player_a then v_final.player_b
                   else v_final.player_a end;
  v_pool   := t.prize_pool_chips;

  -- Positions for everyone, from the round they went out in. A player knocked
  -- out in round r of an R-round bracket shares position 2^(R-r) + 1.
  update public.tournament_entries e
     set final_position = sub.position
    from (
      select tm.tournament_id,
             case when tm.winner = tm.player_a then tm.player_b else tm.player_a end as user_id,
             (2 ^ (v_rounds - tm.round_no) + 1)::int as position
        from public.tournament_matches tm
       where tm.tournament_id = t.id and tm.status = 'complete' and tm.winner is not null
    ) sub
   where e.tournament_id = t.id and e.user_id = sub.user_id;

  update public.tournament_entries set final_position = 1
   where tournament_id = t.id and user_id = v_champ;

  begin
    if v_pool > 0 then
      -- Second computed first so the remainder lands on first: the two shares
      -- then sum to exactly v_pool with no rounding slack anywhere.
      v_second := (v_pool * 3500) / 10000;
      v_first  := v_pool - v_second;

      -- Decided BEFORE either payment, not after. If there is nobody to pay
      -- second, the champion takes the whole pool — and the champion's own
      -- ledger row has to already say so, because a payment written first and
      -- corrected afterwards is exactly the kind of two-step the ledger's
      -- append-only rule exists to forbid.
      if v_runner is null or v_second = 0 then
        v_first := v_pool;
        v_second := 0;
      end if;

      perform public.credit_ledger_strict(v_champ, 'chips', v_first, 'tournament_prize',
        'tprize:' || t.id::text || ':' || v_champ::text);
      perform public.house_credit(-v_first, 'tournament_payout',
        'tpayout:' || t.id::text || ':' || v_champ::text);

      if v_runner is not null and v_second > 0 then
        perform public.credit_ledger_strict(v_runner, 'chips', v_second, 'tournament_prize',
          'tprize:' || t.id::text || ':' || v_runner::text);
        perform public.house_credit(-v_second, 'tournament_payout',
          'tpayout:' || t.id::text || ':' || v_runner::text);
      end if;

      update public.tournament_entries set prize_chips = v_first
       where tournament_id = t.id and user_id = v_champ;
      if v_runner is not null and v_second > 0 then
        update public.tournament_entries set prize_chips = v_second
         where tournament_id = t.id and user_id = v_runner;
      end if;
    end if;

    update public.tournaments set status = 'complete', settled_at = now() where id = t.id;

    v_check := public.tournament_conservation_check(t.id);
    if not (v_check ->> 'conserved')::boolean then
      raise exception 'tournament conservation breach: %', v_check::text
        using errcode = 'P0001';
    end if;

  exception when others then
    -- The payouts above are rolled back with this block, so no bad money
    -- survives; the event is written in the outer transaction, so the alarm
    -- does survive. Getting both is the reason for the nested block.
    perform public.log_integrity_event(
      v_champ, 'tournament_conservation_breach', 'server', null, null,
      jsonb_build_object('tournament_id', t.id, 'pool', v_pool,
                         'sqlstate', sqlstate, 'message', sqlerrm));
    return jsonb_build_object('error', 'conservation_breach', 'detail', sqlerrm);
  end;

  return jsonb_build_object(
    'ok', true, 'tournament_id', t.id,
    'champion', v_champ, 'runner_up', v_runner,
    'pool', v_pool, 'first_prize', v_first, 'second_prize', v_second,
    'conservation', v_check
  );
end $$;
revoke all on function public.tournament_settle(uuid) from public, anon, authenticated;

-- Cancelling refunds every entry along the exact path it came in by, so the
-- identity closes the same way it did on the way out.
create or replace function public.tournament_cancel(p_tournament_id uuid)
returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  t public.tournaments;
  e record;
  v_refunded bigint := 0;
begin
  select * into t from public.tournaments where id = p_tournament_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if t.status in ('complete', 'cancelled') then
    return jsonb_build_object('error', 'already_finished', 'status', t.status);
  end if;

  for e in select user_id from public.tournament_entries where tournament_id = t.id loop
    if t.entry_fee_chips > 0 then
      perform public.credit_ledger_strict(e.user_id, 'chips', t.entry_fee_chips,
        'tournament_refund', 'trefund:' || t.id::text || ':' || e.user_id::text);
      perform public.house_credit(-t.entry_fee_chips, 'tournament_refund',
        'trefund:' || t.id::text || ':' || e.user_id::text);
      v_refunded := v_refunded + t.entry_fee_chips;
    end if;
  end loop;

  update public.tournaments set status = 'cancelled', settled_at = now() where id = t.id;
  return jsonb_build_object('ok', true, 'refunded', v_refunded,
                            'conservation', public.tournament_conservation_check(t.id));
end $$;
revoke all on function public.tournament_cancel(uuid) from public, anon, authenticated;
