-- Collapses a round into one database round trip.
--
-- Measured before this migration: a warm `submit` took p50 519ms / p95 623ms
-- server-to-server, with zero browser network in the number. The reveal budget
-- is 870ms normal and 501ms fast, so fast mode was already over budget before a
-- phone had said a word.
--
-- The cause was not the database. supabase-js inside an Edge Function reaches
-- Postgres through PostgREST over HTTP, so every `.from(...)` was a full
-- network round trip, and `submit` made six of them. These two functions do the
-- same work in one, and as a bonus each is a single transaction — the
-- claim-the-round, recount, and finalize steps can no longer interleave with a
-- concurrent request.
--
-- THE RULES ARE NOT IN HERE. `p_outcomes` is the nine-pair table and
-- `p_wins_needed` the format table, both passed in by the caller, generated
-- from src/utils/rules.ts. This file looks the answer up; it does not know what
-- beats what. That keeps a second implementation of the rules from growing in
-- SQL where the drift test could not see it.

-- ------------------------------------------------------------------- open
create or replace function public.open_round(
  p_match_id   uuid,
  p_user_id    uuid,
  p_move       text,
  p_nonce      text,
  p_commitment text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.matches;
  v_round_number int;
  v_id bigint;
begin
  select * into m from public.matches where id = p_match_id and user_id = p_user_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if m.status <> 'in_progress' then return jsonb_build_object('error', 'match_closed'); end if;

  -- Sweep an abandoned open round. Safe because an open round has no player
  -- move and no outcome: there is nothing here that could later be resolved in
  -- anyone's favour, only a drawn move nobody ever answered.
  delete from public.rounds
   where match_id = p_match_id and state = 'open' and expires_at < now();

  select coalesce(max(round_number), 0) + 1 into v_round_number
    from public.rounds where match_id = p_match_id;

  insert into public.rounds (
    match_id, user_id, round_number, opponent_choice, nonce, commitment, state, expires_at
  ) values (
    p_match_id, p_user_id, v_round_number, p_move, p_nonce, p_commitment, 'open',
    now() + interval '60 seconds'
  )
  returning id into v_id;

  return jsonb_build_object('round_id', v_id, 'round_number', v_round_number);
exception
  when unique_violation then
    -- The partial unique index: a round is already open for this match.
    return jsonb_build_object('error', 'round_already_open');
end $$;

-- ---------------------------------------------------------------- resolve
create or replace function public.resolve_round(
  p_round_id    bigint,
  p_user_id     uuid,
  p_player_move text,
  p_outcomes    jsonb,  -- {"rock:scissors":"win", ...} from src/utils/rules.ts
  p_wins_needed jsonb   -- {"single":1,"bo3":2,"bo5":3}  from src/utils/rules.ts
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rd public.rounds;
  m  public.matches;
  v_outcome  text;
  v_player   int;
  v_opponent int;
  v_needed   int;
  v_complete boolean;
  v_result   text;
  v_claimed  int;
begin
  select * into rd from public.rounds where id = p_round_id and user_id = p_user_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;

  select * into m from public.matches where id = rd.match_id;

  if rd.state = 'resolved' then
    -- Idempotent replay: a retry after a dropped response must return the same
    -- answer, while a different move for a resolved round is the real
    -- double-submit and is refused.
    if rd.player_choice <> p_player_move then
      return jsonb_build_object('error', 'already_submitted');
    end if;
    v_outcome := rd.outcome;

  elsif rd.expires_at <= now() then
    return jsonb_build_object('error', 'round_expired');

  else
    v_outcome := p_outcomes ->> (p_player_move || ':' || rd.opponent_choice);
    if v_outcome is null then return jsonb_build_object('error', 'bad_request'); end if;

    -- Conditional update, not check-then-write: two taps can race, and only a
    -- row still in 'open' transitions. The loser sees zero rows.
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

  -- Recomputed from the resolved rounds rather than incremented, so a retry
  -- cannot inflate the score.
  select count(*) filter (where outcome = 'win'),
         count(*) filter (where outcome = 'lose')
    into v_player, v_opponent
    from public.rounds
   where match_id = rd.match_id and state = 'resolved';

  v_needed   := (p_wins_needed ->> m.format)::int;
  v_complete := v_player >= v_needed or v_opponent >= v_needed;

  -- Not an independent rule: the match ends exactly when someone reaches
  -- wins_needed, so whoever reached it is the winner, and a finished match can
  -- never be a draw. Ties replay and never advance the score.
  v_result := case when v_complete then (case when v_player >= v_needed then 'win' else 'lose' end) end;

  -- One statement, identical shape on every round. If finishing a match cost an
  -- extra query, response time would correlate with "this round was decisive" —
  -- a leak the animation cannot hide.
  update public.matches
     set player_score   = v_player,
         opponent_score = v_opponent,
         status         = case when v_complete then 'complete' else 'in_progress' end,
         result         = v_result,
         finalized_at   = case when v_complete then now() end
   where id = rd.match_id;

  return jsonb_build_object(
    'round_number',    rd.round_number,
    'commitment',      rd.commitment,
    'opponent_choice', rd.opponent_choice,
    'nonce',           rd.nonce,
    'outcome',         v_outcome,
    'score',           jsonb_build_object('player', v_player, 'opponent', v_opponent),
    'match_complete',  v_complete,
    'match_result',    v_result
  );
end $$;

-- These take the outcome table as an ARGUMENT. A client able to call
-- resolve_round directly could hand in a table that says everything is a win,
-- so only the service role — that is, the Edge Function — may execute them.
revoke all on function public.open_round(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.resolve_round(bigint, uuid, text, jsonb, jsonb) from public, anon, authenticated;
