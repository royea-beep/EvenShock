-- Skill layer, part 8 of the EVENSHOCK-SKILL-LAYER brief: wiring, so the
-- numbers maintain themselves instead of waiting for someone to run a backfill.
--
-- THE RULE THIS MIGRATION IS BUILT AROUND: a failure in the skill layer must
-- never cost a player their match result or their money. Ratings are derived
-- data — they can be rebuilt from rounds at any time by
-- refresh_all_player_skill_metrics. A settled pot cannot be rebuilt. So both
-- call sites wrap the skill work in its own subtransaction and, on any error,
-- record a `skill_update_failed` integrity event and carry on. The match still
-- finalizes, the payout still lands, and the failure is visible in the same
-- table every other integrity problem lands in rather than in a log nobody
-- reads.
--
-- That asymmetry is deliberate and is why `skill_update_failed` was added to
-- the integrity_events vocabulary: it is a repairable inconsistency, not a
-- money incident, and it should be able to be raised without implying one.
--
-- KNOWN SCALING BOUNDARY, recorded rather than pre-optimised: the refresh
-- recomputes a player from their whole history on every match completion. It
-- is idempotent by design, which is what makes it safe to retry or to skip,
-- and at present the largest account is 378 rounds across 57 matches, which is
-- nothing. It becomes worth making incremental somewhere around a player with
-- a few thousand matches; the honest trigger to watch is the round-submission
-- latency the harness already measures.

-- ---------------------------------------------------------- solo: skill only
-- Note what is NOT here: no rating call. Solo opponents are uniform random, so
-- a solo result says nothing about who is better (see the glicko2 migration).
-- The player's own throw sequence is still real evidence about how readable
-- they are, so the skill metrics do update.
create or replace function public.resolve_round(
  p_round_id bigint, p_user_id uuid, p_player_move text,
  p_outcomes jsonb, p_wins_needed jsonb, p_economy jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare
  rd public.rounds;
  m  public.matches;
  v_outcome  text;
  v_rounds   int;
  v_player   int;
  v_opponent int;
  v_needed   int;
  v_complete boolean;
  v_result   text;
  v_claimed  int;
  v_xp       bigint := 0;
  v_chips    bigint := 0;
begin
  if not public.take_rate_token(p_user_id, 'submit') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  select * into rd from public.rounds where id = p_round_id and user_id = p_user_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;

  select * into m from public.matches where id = rd.match_id;

  if rd.state = 'resolved' then
    if rd.player_choice <> p_player_move then
      perform public.log_integrity_event(
        p_user_id, 'move_changed_after_resolution', 'server', rd.match_id, rd.id,
        jsonb_build_object('recorded_move', rd.player_choice, 'attempted_move', p_player_move)
      );
      return jsonb_build_object('error', 'already_submitted');
    end if;
    v_outcome := rd.outcome;

  elsif rd.expires_at <= now() then
    perform public.log_integrity_event(
      p_user_id, 'expired_round_submission', 'server', rd.match_id, rd.id,
      jsonb_build_object('expired_at', rd.expires_at, 'late_by_seconds',
                         round(extract(epoch from (now() - rd.expires_at))))
    );
    return jsonb_build_object('error', 'round_expired');

  else
    v_outcome := p_outcomes ->> (p_player_move || ':' || rd.opponent_choice);
    if v_outcome is null then return jsonb_build_object('error', 'bad_request'); end if;

    update public.rounds
       set state = 'resolved', player_choice = p_player_move,
           outcome = v_outcome, resolved_at = now()
     where id = rd.id and state = 'open';
    get diagnostics v_claimed = row_count;

    if v_claimed = 0 then
      select * into rd from public.rounds where id = p_round_id;
      if rd.player_choice is distinct from p_player_move then
        return jsonb_build_object('error', 'already_submitted');
      end if;
      v_outcome := rd.outcome;
    end if;
  end if;

  select count(*),
         count(*) filter (where outcome = 'win'),
         count(*) filter (where outcome = 'lose')
    into v_rounds, v_player, v_opponent
    from public.rounds
   where match_id = rd.match_id and state = 'resolved';

  v_needed   := (p_wins_needed ->> m.format)::int;
  v_complete := v_player >= v_needed or v_opponent >= v_needed;
  v_result := case when v_complete then (case when v_player >= v_needed then 'win' else 'lose' end) end;

  update public.matches
     set player_score   = v_player,
         opponent_score = v_opponent,
         status         = case when v_complete then 'complete' else 'in_progress' end,
         result         = v_result,
         finalized_at   = case when v_complete then now() end
   where id = rd.match_id;

  if v_complete then
    v_xp    := coalesce((p_economy ->> 'xp_per_round')::bigint, 0)        * v_rounds;
    v_chips := coalesce((p_economy ->> 'chips_per_round_won')::bigint, 0) * v_player;

    if v_xp > 0 then
      perform public.credit_ledger(p_user_id, 'xp', v_xp, 'match_reward',
                                   'reward:' || rd.match_id::text || ':xp', rd.match_id);
    end if;
    if v_chips > 0 then
      perform public.credit_ledger(p_user_id, 'chips', v_chips, 'match_reward',
                                   'reward:' || rd.match_id::text || ':chips', rd.match_id);
    end if;

    -- Derived data, in its own subtransaction. If this throws, the match is
    -- still complete and the reward has still landed; only the metrics are
    -- stale, and refresh_all_player_skill_metrics repairs that at any time.
    begin
      perform public.refresh_player_skill_metrics(p_user_id);
    exception when others then
      perform public.log_integrity_event(
        p_user_id, 'skill_update_failed', 'server', rd.match_id, rd.id,
        jsonb_build_object('stage', 'resolve_round', 'sqlstate', sqlstate, 'message', sqlerrm));
    end;
  end if;

  return jsonb_build_object(
    'round_number',    rd.round_number,
    'commitment',      rd.commitment,
    'opponent_choice', rd.opponent_choice,
    'nonce',           rd.nonce,
    'outcome',         v_outcome,
    'score',           jsonb_build_object('player', v_player, 'opponent', v_opponent),
    'match_complete',  v_complete,
    'match_result',    v_result,
    'award',           case when v_complete
                            then jsonb_build_object('xp', v_xp, 'chips', v_chips)
                            else jsonb_build_object('xp', 0, 'chips', 0) end
  );
end $function$;

-- ------------------------------------------------- human play: rating + skill
-- The rating call sits AFTER the row is marked settled, because rate_mp_table
-- refuses anything that is not settlement = 'decided' — which is what stops it
-- rating a void, and would equally stop it rating this table if it were called
-- a few lines earlier. Ordering is load-bearing.
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
    -- A free table still decides who is better, so it still rates.
    if p_kind = 'decided' then
      begin
        perform public.rate_mp_table(t.id);
      exception when others then
        perform public.log_integrity_event(
          t.seat_a, 'skill_update_failed', 'server', null, null,
          jsonb_build_object('stage', 'mp_settle_free', 'table_id', t.id,
                             'sqlstate', sqlstate, 'message', sqlerrm));
      end;
    end if;
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

  -- Ratings are derived; the pot is not. This runs last and cannot take the
  -- settlement down with it.
  if p_kind = 'decided' then
    begin
      perform public.rate_mp_table(t.id);
    exception when others then
      perform public.log_integrity_event(
        t.seat_a, 'skill_update_failed', 'server', null, null,
        jsonb_build_object('stage', 'mp_settle', 'table_id', t.id,
                           'sqlstate', sqlstate, 'message', sqlerrm));
    end;
  end if;

  return jsonb_build_object('ok', true, 'kind', p_kind, 'pot', t.pot_chips,
    'payout', case when p_kind = 'decided' then t.payout_chips else v_refunded end,
    'rake', case when p_kind = 'decided' then t.rake_chips else 0 end,
    'refunded', v_refunded,
    'winner', v_winner, 'house_balance', public.house_balance());
end $function$;
