-- The ladder, as something a player can see themselves entering.
--
-- Today it is an empty list behind a button, which is the worst possible
-- shape: a newcomer learns only that nobody is here. What a first player needs
-- to see is where they would stand and what the last match did to it — a
-- board is motivating because it MOVES, not because it exists.
--
-- RANK MOVEMENT IS DERIVED FROM rating_history, NOT STORED. The history table
-- already records rating_before and rating_after for every rated match, so
-- "you gained 12 points" is a fact recomputed from the row that caused it
-- rather than a counter that could drift from the ratings it describes. Same
-- reasoning as the Nemesis before/after predictability being computed twice
-- from the same function rather than remembered.

create or replace function public.ladder_snapshot(p_user_id uuid, p_limit int default 20)
returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_board jsonb;
  v_me    jsonb;
  v_total int;
  v_rank  int;
begin
  -- The board itself, already filtered to rateable players by the view's own
  -- rules — harness accounts, the owner and the treasury are excluded there,
  -- so this function inherits that rather than restating it.
  select count(*) into v_total from public.season_leaderboard();

  -- The view already ranks; recomputing it here would risk two orderings that
  -- disagree at a tie, and the board a player sees must be the board.
  select coalesce(jsonb_agg(jsonb_build_object(
           'rank', r.rank, 'user_id', r.user_id, 'name', r.display_name,
           'rating', round(r.rating), 'matches', r.matches_played,
           'is_you', r.user_id = p_user_id) order by r.rank), '[]'::jsonb)
    into v_board
    from (select l.* from public.season_leaderboard() l
           order by l.rank limit greatest(1, least(100, p_limit))) r;

  -- Where the caller stands, even when they are below the visible window. A
  -- board that silently omits you is worse than one that tells you the number.
  select l.rank into v_rank from public.season_leaderboard() l
   where l.user_id = p_user_id;

  select jsonb_build_object(
    'on_board', v_rank is not null,
    'rank',     v_rank,
    'rating',   (select round(rating) from public.player_ratings where user_id = p_user_id),
    'rated_matches', (select rated_matches from public.player_ratings where user_id = p_user_id),
    -- THE MOVEMENT. Null when nothing has been rated yet, which is honest —
    -- a first-time player has not moved, they have arrived.
    'last_change', (
      select jsonb_build_object(
        'delta',      round(h.rating_after - h.rating_before),
        'rating',     round(h.rating_after),
        'outcome',    case when h.outcome > 0.5 then 'win'
                           when h.outcome < 0.5 then 'loss' else 'draw' end,
        'at',         h.rated_at)
        from public.rating_history h
       where h.user_id = p_user_id
       order by h.rated_at desc, h.id desc limit 1),
    'rateable', public.is_rateable_player(p_user_id)
  ) into v_me;

  return jsonb_build_object(
    'total_players', v_total,
    'board',         v_board,
    'you',           v_me,
    -- Said plainly so the UI can be honest rather than looking broken: an
    -- empty ladder is the true state, not a failed load.
    'empty_reason',  case when v_total = 0
                       then 'no rated players yet — the ladder counts finished head-to-head matches only'
                     end);
end $$;
revoke all on function public.ladder_snapshot(uuid, int) from public, anon;
grant execute on function public.ladder_snapshot(uuid, int) to authenticated;
