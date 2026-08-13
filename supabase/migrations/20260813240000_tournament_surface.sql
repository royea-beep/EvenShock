-- The tournament SURFACE: what a player can see and do, and the wiring that
-- lets a bracket finish itself.
--
-- The backend shipped in 20260813220000 is complete and unreachable. Every
-- tournament_* function is revoked from anon and authenticated — correctly, it
-- moves chips — so nothing in a browser can call one. This migration adds the
-- read model the UI renders from, binds bracket slots to REAL mp tables, and
-- closes the loop so that finishing the final settles the prize pool.
--
-- ONE PATH, NOT TWO. A tournament match is an ordinary mp table: created by
-- mp_create_table, joined by mp_join_table, played through the same
-- commit-reveal the versus screen already drives, settled by mp_settle. The
-- bracket slot just remembers which table it was. Nothing here re-implements
-- seating, escrow, or the round protocol, so a tournament match cannot drift
-- from a friendly one — it IS one, with a row pointing at it.
--
-- TOURNAMENT MATCHES ARE STAKE-ZERO, ALWAYS. The money in a tournament is the
-- entry fee, taken once at registration. The tables themselves are free, which
-- is what keeps the whole feature clear of `stake_tables`: no table created
-- here ever carries a wager, so the flag stays off and the trigger that
-- rejects staked inserts is never even approached.

create index if not exists tournament_matches_mp_table
  on public.tournament_matches (mp_table_id) where mp_table_id is not null;

-- ------------------------------------------------------------- display names
-- Same rendering as the leaderboard: a chosen name, or a truncated wallet.
-- Extracted so the two surfaces cannot start disagreeing about what to call
-- somebody.
create or replace function public.player_label(p_user_id uuid)
returns text
language sql stable parallel safe set search_path to '' as $$
  select coalesce(nullif(p.display_name, ''),
                  left(p.wallet_address, 4) || '…' || right(p.wallet_address, 4))
    from public.profiles p where p.id = p_user_id;
$$;

-- ---------------------------------------------------------------- the lobby
-- Everything the list needs in one round trip, including whether THIS player
-- can join and, if not, why. Returning the reason rather than just a boolean
-- is what lets the UI say "you're already in" instead of grey-ing out a button
-- with no explanation.
create or replace function public.tournament_list(p_user_id uuid)
returns table (
  id               uuid,
  name             text,
  status           text,
  format           text,
  entry_fee_chips  bigint,
  prize_pool_chips bigint,
  max_players      int,
  entrants         bigint,
  starts_at        timestamptz,
  you_entered      boolean,
  join_block       text
)
language sql stable security definer set search_path to '' as $$
  with counted as (
    select t.*,
           -- Harness and owner accounts cannot register, and are excluded from
           -- the count as well: a lobby that says "3/8" when one of the three
           -- is a test rig is lying about how full the draw is.
           (select count(*) from public.tournament_entries e
             where e.tournament_id = t.id and public.is_rateable_player(e.user_id)) as entrants,
           exists (select 1 from public.tournament_entries e
                    where e.tournament_id = t.id and e.user_id = p_user_id) as mine
      from public.tournaments t
     where t.status in ('upcoming', 'registering', 'running')
  )
  select c.id, c.name, c.status, c.format, c.entry_fee_chips, c.prize_pool_chips,
         c.max_players, c.entrants, c.starts_at, c.mine,
         case
           when c.mine                                    then 'already_entered'
           when c.status <> 'registering'                 then 'not_registering'
           when c.entrants >= c.max_players               then 'full'
           when not public.is_rateable_player(p_user_id)  then 'unrateable_player'
           when c.entry_fee_chips >
                coalesce((select b.chips from public.balances b where b.user_id = p_user_id), 0)
                                                          then 'insufficient_chips'
         end
    from counted c
   order by case c.status when 'registering' then 0 when 'running' then 1 else 2 end,
            c.starts_at nulls last, c.name;
$$;
revoke all on function public.tournament_list(uuid) from public, anon, authenticated;

-- --------------------------------------------------------------- the bracket
-- Rendered top to bottom. `your_turn` is the whole interaction model: it is
-- true on exactly the slots this player is in, that are ready, and that have
-- not been decided — which is the set of "Play" buttons the screen shows.
create or replace function public.tournament_bracket(p_tournament_id uuid, p_user_id uuid)
returns table (
  round_no     int,
  slot         int,
  status       text,
  player_a     uuid,
  player_a_name text,
  player_a_seed int,
  player_b     uuid,
  player_b_name text,
  player_b_seed int,
  winner       uuid,
  mp_table_id  uuid,
  your_turn    boolean
)
language sql stable security definer set search_path to '' as $$
  select tm.round_no, tm.slot, tm.status,
         tm.player_a, public.player_label(tm.player_a),
         (select e.seed from public.tournament_entries e
           where e.tournament_id = tm.tournament_id and e.user_id = tm.player_a),
         tm.player_b, public.player_label(tm.player_b),
         (select e.seed from public.tournament_entries e
           where e.tournament_id = tm.tournament_id and e.user_id = tm.player_b),
         tm.winner, tm.mp_table_id,
         (tm.status = 'pending'
          and tm.player_a is not null and tm.player_b is not null
          and p_user_id in (tm.player_a, tm.player_b))
    from public.tournament_matches tm
   where tm.tournament_id = p_tournament_id
   order by tm.round_no, tm.slot;
$$;
revoke all on function public.tournament_bracket(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------- the honest payout
-- Modelled on what the pot screen already does for a friendly stake: show the
-- arithmetic, not just the arrival.
--
-- The line that matters and is easy to leave out: THE HOUSE TAKES NOTHING from
-- a tournament pool. Every chip collected in entry fees is paid back out to
-- first and second. That is a real difference from a staked table, where the
-- rake is a visible line item, and hiding it would be hiding good news — but
-- it would also make the two screens silently inconsistent about where money
-- goes, which is how a player learns not to trust either.
create or replace function public.tournament_result(p_tournament_id uuid, p_user_id uuid)
returns jsonb
language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'tournament_id', t.id,
    'name',          t.name,
    'status',        t.status,
    'entry_fee',     t.entry_fee_chips,
    'pool',          t.prize_pool_chips,
    'house_cut',     0,
    'entrants',      (select count(*) from public.tournament_entries e where e.tournament_id = t.id),
    'you', case when me.user_id is null then null else jsonb_build_object(
             'seed',      me.seed,
             'position',  me.final_position,
             'prize',     me.prize_chips,
             'paid',      t.entry_fee_chips,
             'net',       me.prize_chips - t.entry_fee_chips) end,
    'podium', coalesce((
      select jsonb_agg(jsonb_build_object(
               'position', e.final_position,
               'name',     public.player_label(e.user_id),
               'prize',    e.prize_chips) order by e.final_position)
        from public.tournament_entries e
       where e.tournament_id = t.id and e.prize_chips > 0
         and public.is_rateable_player(e.user_id)), '[]'::jsonb)
  )
  from public.tournaments t
  left join public.tournament_entries me
    on me.tournament_id = t.id and me.user_id = p_user_id
 where t.id = p_tournament_id;
$$;
revoke all on function public.tournament_result(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------- binding a slot to a table
-- The first of the two players to press Play creates the table; the second
-- joins it. Both go through the ordinary mp RPCs, so seating, sweeping and the
-- treasury guard all behave exactly as they do for a friendly match.
create or replace function public.tournament_open_match(
  p_tournament_id uuid, p_round_no int, p_slot int, p_user_id uuid
) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  t   public.tournaments;
  m   public.tournament_matches;
  tbl public.mp_tables;
  v   jsonb;
begin
  select * into t from public.tournaments where id = p_tournament_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if t.status <> 'running' then
    return jsonb_build_object('error', 'not_running', 'status', t.status);
  end if;

  select * into m from public.tournament_matches
   where tournament_id = p_tournament_id and round_no = p_round_no and slot = p_slot
     for update;
  if not found then return jsonb_build_object('error', 'no_such_slot'); end if;

  -- Only the two players in the slot. Without this any entrant could seat
  -- themselves into somebody else's bracket match.
  if p_user_id is distinct from m.player_a and p_user_id is distinct from m.player_b then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if m.status = 'complete' then
    return jsonb_build_object('error', 'already_reported', 'winner', m.winner);
  end if;
  if m.player_a is null or m.player_b is null then
    return jsonb_build_object('error', 'slot_not_ready');
  end if;

  if m.mp_table_id is not null then
    select * into tbl from public.mp_tables where id = m.mp_table_id;
    -- A table that expired or was swept before both players arrived must not
    -- dead-end the bracket: drop the binding and fall through to making a new
    -- one.
    if found and tbl.status in ('open', 'playing') then
      if p_user_id in (tbl.seat_a, tbl.seat_b) then
        return jsonb_build_object('ok', true, 'table_id', tbl.id,
          'invite_code', tbl.invite_code, 'format', tbl.format,
          'seat', case when tbl.seat_a = p_user_id then 'a' else 'b' end,
          'rejoined', true);
      end if;
      v := public.mp_join_table(p_user_id, tbl.invite_code);
      if v ? 'error' then return v; end if;
      return v || jsonb_build_object('invite_code', tbl.invite_code);
    end if;
    update public.tournament_matches set mp_table_id = null
     where tournament_id = p_tournament_id and round_no = p_round_no and slot = p_slot;
  end if;

  -- Stake ZERO, hard-coded rather than passed: there is no argument any caller
  -- can supply that turns a bracket match into a wager.
  v := public.mp_create_table(p_user_id, t.format, 0);
  if v ? 'error' then return v; end if;

  update public.tournament_matches set mp_table_id = (v ->> 'table_id')::uuid
   where tournament_id = p_tournament_id and round_no = p_round_no and slot = p_slot;

  return v || jsonb_build_object('created', true);
end $$;
revoke all on function public.tournament_open_match(uuid, int, int, uuid) from public, anon, authenticated;

-- --------------------------------------------------- closing the bracket loop
-- Everything that should happen after a table settles, in one place.
--
-- WHY THIS EXISTS RATHER THAN MORE LINES IN mp_settle: mp_settle is the money
-- function. It has now been edited twice for the skill layer, and every edit to
-- it is a risk taken against the one code path that pays people. Hooks that
-- follow a settlement are not settlement, so they live here and mp_settle
-- calls one function — meaning the next hook after this one does not reopen
-- the payout code at all.
--
-- Each hook gets its OWN subtransaction. A rating failure must not stop a
-- bracket advancing, and neither may stop the settlement that already
-- happened.
create or replace function public.mp_post_settle_hooks(p_table_id uuid)
returns void
language plpgsql security definer set search_path to '' as $$
declare
  t  public.mp_tables;
  tm public.tournament_matches;
  v_winner uuid;
begin
  select * into t from public.mp_tables where id = p_table_id;
  if not found or t.settlement is distinct from 'decided' or t.result is null then return; end if;
  v_winner := case when t.result = 'a' then t.seat_a else t.seat_b end;

  begin
    perform public.rate_mp_table(t.id);
  exception when others then
    perform public.log_integrity_event(
      t.seat_a, 'skill_update_failed', 'server', null, null,
      jsonb_build_object('stage', 'rate_mp_table', 'table_id', t.id,
                         'sqlstate', sqlstate, 'message', sqlerrm));
  end;

  begin
    select * into tm from public.tournament_matches where mp_table_id = t.id;
    if found and tm.status = 'pending' then
      perform public.tournament_report_result(tm.tournament_id, tm.round_no, tm.slot,
                                              v_winner, t.id);
    end if;
  exception when others then
    perform public.log_integrity_event(
      t.seat_a, 'skill_update_failed', 'server', null, null,
      jsonb_build_object('stage', 'tournament_report', 'table_id', t.id,
                         'sqlstate', sqlstate, 'message', sqlerrm));
  end;
end $$;
revoke all on function public.mp_post_settle_hooks(uuid) from public, anon, authenticated;

-- Reporting the FINAL settles the pool. Without this a finished tournament
-- sits at 'running' with everyone's entry fees inside the house until an
-- operator notices — which is indistinguishable, from a player's side, from
-- having been robbed.
create or replace function public.tournament_report_result(
  p_tournament_id uuid, p_round_no int, p_slot int,
  p_winner uuid, p_mp_table_id uuid default null
) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  m        public.tournament_matches;
  v_rounds int;
  v_settle jsonb;
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
     set winner = p_winner, status = 'complete', mp_table_id = coalesce(p_mp_table_id, mp_table_id)
   where tournament_id = p_tournament_id and round_no = p_round_no and slot = p_slot;

  perform public.tournament_advance(p_tournament_id, p_round_no, p_slot, p_winner, v_rounds);

  if p_round_no = v_rounds then
    -- tournament_settle guards its own money and returns an error object
    -- rather than raising, so a refusal here cannot roll back the result that
    -- was just recorded. The bracket stays true even if the payout has to be
    -- retried.
    v_settle := public.tournament_settle(p_tournament_id);
  end if;

  return jsonb_build_object('ok', true, 'round', p_round_no, 'slot', p_slot,
                            'winner', p_winner, 'settled', v_settle);
end $$;
revoke all on function public.tournament_report_result(uuid, int, int, uuid, uuid)
  from public, anon, authenticated;

-- Filling the last seat starts the draw. Same reasoning as auto-settle: a
-- lobby that reaches 8/8 and then waits for an operator is a dead end the
-- player cannot tell from a bug.
create or replace function public.tournament_register(p_tournament_id uuid, p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  t public.tournaments;
  v_count int;
  v_balance bigint;
  v_started jsonb;
begin
  select * into t from public.tournaments where id = p_tournament_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if t.status <> 'registering' then
    return jsonb_build_object('error', 'not_registering', 'status', t.status);
  end if;

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

  if v_count + 1 >= t.max_players then
    v_started := public.tournament_start(t.id);
  end if;

  return jsonb_build_object('ok', true, 'tournament_id', t.id,
                            'entered', v_count + 1, 'started', v_started);
end $$;
revoke all on function public.tournament_register(uuid, uuid) from public, anon, authenticated;

-- mp_settle, now delegating everything that follows a settlement to the hook
-- function above. The payout logic is byte-identical to what it replaced; the
-- only change is that the two inline guarded blocks became one call.
create or replace function public.mp_settle(p_table_id uuid, p_kind text)
returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare
  t public.mp_tables;
  v_winner uuid; v_loser uuid; v_first uuid; v_second uuid;
  v_house bigint; v_seat uuid; v_posted bigint; v_refunded bigint := 0;
begin
  select * into t from public.mp_tables where id = p_table_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if t.settled_at is not null then
    return jsonb_build_object('ok', true, 'already_settled', t.settlement);
  end if;

  if t.stake_chips = 0 then
    update public.mp_tables set settled_at = now(), settlement = p_kind where id = t.id;
    -- A free table still decides who is better, and may be a bracket slot.
    perform public.mp_post_settle_hooks(t.id);
    return jsonb_build_object('ok', true, 'free', true);
  end if;

  v_first  := least(t.seat_a, t.seat_b);
  v_second := greatest(t.seat_a, t.seat_b);
  perform 1 from public.balances where user_id = v_first  for update;
  perform 1 from public.balances where user_id = v_second for update;

  if p_kind = 'decided' then
    if t.result is null then return jsonb_build_object('error', 'no_result'); end if;
    v_winner := case when t.result = 'a' then t.seat_a else t.seat_b end;
    v_loser  := case when t.result = 'a' then t.seat_b else t.seat_a end;

    -- STRICT: a payout that does not land aborts the transaction; the rake
    -- below never fires. The settled_at guard makes legitimate retries safe.
    perform public.credit_ledger_strict(v_winner, 'chips', t.payout_chips, 'stake_payout',
      'payout:' || t.id::text || ':' || v_winner::text, null, null, t.id);

    if t.rake_chips > 0 then
      insert into public.house_ledger (delta, reason, table_id, idem_key, balance_after)
      values (t.rake_chips, 'rake', t.id, 'rake:' || t.id::text, 0)
      on conflict (idem_key) do nothing;
      if not found then
        raise exception 'rake did not land: table=%', t.id using errcode = 'P0001';
      end if;
      select public.house_balance() into v_house;
      update public.house_ledger set balance_after = v_house
       where idem_key = 'rake:' || t.id::text;
    end if;

  elsif p_kind = 'void' then
    for v_seat, v_posted in
      select l.user_id, -sum(l.delta)
        from public.ledger l
       where l.mp_table_id = t.id and l.reason = 'stake_post'
       group by l.user_id
    loop
      perform public.credit_ledger_strict(v_seat, 'chips', v_posted, 'stake_refund',
        'refund:' || t.id::text || ':' || v_seat::text, null, null, t.id);
      v_refunded := v_refunded + v_posted;
    end loop;
  else
    return jsonb_build_object('error', 'bad_kind');
  end if;

  update public.mp_tables
     set settled_at = now(), settlement = p_kind,
         status = 'finished', closed_at = coalesce(closed_at, now())
   where id = t.id;

  -- Everything that FOLLOWS a settlement -- ratings, bracket advance -- lives in
  -- one hook function, each step in its own subtransaction. This is the last
  -- line of the money path, and adding the next hook will not reopen it.
  perform public.mp_post_settle_hooks(t.id);

  return jsonb_build_object('ok', true, 'kind', p_kind, 'pot', t.pot_chips,
    'payout', case when p_kind = 'decided' then t.payout_chips else v_refunded end,
    'rake', case when p_kind = 'decided' then t.rake_chips else 0 end,
    'refunded', v_refunded,
    'winner', v_winner, 'house_balance', public.house_balance());
end $function$;
