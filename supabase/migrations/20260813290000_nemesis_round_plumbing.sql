-- NEMESIS, part 3: the round plumbing.
--
-- `open_match` learns which opponent was chosen, and `open_round` learns to
-- record what Nemesis did in the SAME transaction as the round it did it in.
-- A round and its Nemesis record that could be written separately could also
-- disagree, and the post-match feedback would then be describing a round that
-- did not happen that way.
--
-- BOTH ARE DROPPED AND RECREATED rather than overloaded. Adding a parameter
-- with a default to a live function creates a second signature, and this
-- project has already been bitten by exactly that — see
-- drop_credit_ledger_overload. One function, one signature.

drop function if exists public.open_match(uuid, text, text, boolean);

create or replace function public.open_match(
  p_user_id   uuid,
  p_format    text,
  p_theme     text,
  p_fast_mode boolean,
  p_opponent  text default 'random'
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare v_id uuid;
begin
  if not public.take_rate_token(p_user_id, 'open_match') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  if coalesce(p_opponent, 'random') not in ('random', 'nemesis') then
    return jsonb_build_object('error', 'bad_request');
  end if;

  insert into public.matches (user_id, format, player_score, opponent_score, result,
                              status, theme, fast_mode, opponent)
  values (p_user_id, p_format, 0, 0, null, 'in_progress', p_theme,
          coalesce(p_fast_mode, false), coalesce(p_opponent, 'random'))
  returning id into v_id;

  return jsonb_build_object('match_id', v_id, 'opponent', coalesce(p_opponent, 'random'));
end $function$;

drop function if exists public.open_round(uuid, uuid, text, text, text);

create or replace function public.open_round(
  p_match_id   uuid,
  p_user_id    uuid,
  p_move       text,
  p_nonce      text,
  p_commitment text,
  -- What Nemesis decided for this round, or NULL for the uniform bot. Written
  -- with the round, never after it.
  p_nemesis    jsonb default null
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare
  m public.matches;
  v_round_number int;
  v_id bigint;
begin
  if not public.take_rate_token(p_user_id, 'open_round') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  select * into m from public.matches where id = p_match_id and user_id = p_user_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if m.status <> 'in_progress' then return jsonb_build_object('error', 'match_closed'); end if;

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

  if p_nemesis is not null then
    insert into public.nemesis_rounds (
      round_id, exploited, model, context, predicted, counter, ctx_weight, exploit_rate
    ) values (
      v_id,
      coalesce((p_nemesis ->> 'exploited')::boolean, false),
      p_nemesis ->> 'model',
      p_nemesis ->> 'context',
      p_nemesis ->> 'predicted',
      p_nemesis ->> 'counter',
      (p_nemesis ->> 'ctx_weight')::numeric,
      coalesce((p_nemesis ->> 'exploit_rate')::numeric, 0)
    )
    on conflict (round_id) do nothing;
  end if;

  return jsonb_build_object('round_id', v_id, 'round_number', v_round_number);
exception
  when unique_violation then
    return jsonb_build_object('error', 'round_already_open');
end $function$;
