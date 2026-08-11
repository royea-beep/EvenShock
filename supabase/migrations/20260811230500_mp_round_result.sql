-- What a resolved round looks like to both players — including the first
-- revealer, who otherwise could never see the opponent's hand.
--
-- THE GAP THIS FILLS. `mp_reveal` returns both moves only to whoever reveals
-- SECOND, because that is the moment both are in. The first revealer gets
-- `{waiting_for_opponent: true}` and nothing else, by design. But after the
-- round resolves, that player still has to be shown what beat them — and
-- `mp_state` deliberately carries only the outcome, because it is polled while
-- rounds are still open and must never become a leak surface.
--
-- So the reveal payload gets its own function, gated on the round being over.
-- The leak rule is unchanged and now easier to check: nothing here returns
-- anything until `state` is 'resolved' or 'void', and mp_state stays the
-- during-play endpoint that knows nothing.
--
-- IT ALSO MAKES THE SERVER CHECKABLE. Returning both commitments alongside
-- both (move, nonce) pairs lets the client recompute
-- sha256(round_id ‖ seat ‖ move ‖ nonce) and prove the server revealed exactly
-- what it committed to. "The server is in the trust base" stays inspectable
-- rather than assumed — a player who is told they lost can verify that the
-- move that beat them is the one that was locked in before either side moved.
--
-- Binding on SEAT rather than user id, deliberately. It defeats the
-- commitment-copy attack identically — a and b cannot share a digest — and it
-- is verifiable by a client that does not know the opponent's user id, which
-- means we never have to expose one to make fairness checkable.
create or replace function public.mp_round_result(p_user_id uuid, p_round_id bigint)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare r public.mp_rounds; t public.mp_tables; v_seat text;
begin
  select * into r from public.mp_rounds where id = p_round_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;

  select * into t from public.mp_tables where id = r.table_id;
  v_seat := case when t.seat_a = p_user_id then 'a'
                 when t.seat_b = p_user_id then 'b' end;
  if v_seat is null then return jsonb_build_object('error', 'not_found'); end if;

  -- The whole guard. An unresolved round tells the caller nothing at all —
  -- not even a shape it could time.
  if r.state not in ('resolved', 'void') then
    return jsonb_build_object('ok', true, 'settled', false);
  end if;

  return jsonb_build_object(
    'ok', true, 'settled', true,
    'round_id', r.id, 'round_number', r.round_number,
    'state', r.state, 'outcome', r.outcome, 'resolution', r.resolution,
    'you', v_seat,
    'a_move', r.a_move, 'b_move', r.b_move,
    'a_nonce', r.a_nonce, 'b_nonce', r.b_nonce,
    'a_commitment', r.a_commitment, 'b_commitment', r.b_commitment,
    'score', jsonb_build_object('a', t.a_score, 'b', t.b_score),
    'table_status', t.status, 'table_result', t.result,
    'stake', t.stake_chips, 'pot', t.pot_chips,
    'rake', t.rake_chips, 'payout', t.payout_chips
  );
end $$;
revoke all on function public.mp_round_result(uuid, bigint) from public, anon, authenticated;

comment on function public.mp_round_result(uuid, bigint) is
  'Resolved-round reveal, including both (move, nonce) pairs and both commitments so a client can verify the server revealed what it committed to. Returns settled=false and nothing else while the round is live.';
