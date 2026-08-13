-- Leaderboard: require a minimum number of finalized matches to appear.
--
-- Two things this migration does:
--
--   1. Adds a `p_min_matches` parameter (default 5). A player needs at least
--      that many COMPLETED matches to show up on the board — one lucky win
--      no longer reads as a legend, and refreshing the page after a first
--      match doesn't stamp your face on the top spot. The floor is a
--      parameter, not a constant, because different views want different
--      floors (site-wide leaderboard: 5; a "rising star" panel: 1; an
--      end-of-season ranking: 20).
--
--   2. Codifies the two production-side properties that were live but
--      undocumented on main:
--        - guest exclusion is grant-based (`grant execute ... to
--          authenticated`), so a caller with no session cannot even call
--          the function
--        - only finalized matches count (`m.status = 'complete'`), so
--          walking out of a losing match doesn't rescue your rank
--
-- The function replaces the earlier version in place; nothing else references
-- the old signature (client uses `p_limit` only, and the new parameter is
-- optional with a sensible default).

create or replace function public.leaderboard(
  p_limit int default 100,
  p_min_matches int default 5
)
returns table (
  rank           bigint,
  user_id        uuid,
  display_name   text,
  matches_played bigint,
  wins           bigint,
  losses         bigint,
  ties           bigint,
  win_rate       numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with qualifying as (
    select
      p.id, p.display_name, p.wallet_address, p.created_at,
      count(*)                                as played,
      count(*) filter (where m.result = 'win')  as wins,
      count(*) filter (where m.result = 'lose') as losses,
      count(*) filter (where m.result = 'tie')  as ties
    from public.profiles p
    join public.matches m
      on m.user_id = p.id
     and m.status = 'complete'
    group by p.id, p.display_name, p.wallet_address, p.created_at
    having count(*) >= greatest(1, coalesce(p_min_matches, 5))
  )
  select
    row_number() over (
      order by wins desc,
               played asc,
               created_at asc
    ) as rank,
    id,
    -- Short wallet address when no display_name is set (web3 convention).
    -- Full wallet_address is never returned by this function.
    coalesce(
      nullif(display_name, ''),
      left(wallet_address, 4) || '…' || right(wallet_address, 4)
    ),
    played,
    wins,
    losses,
    ties,
    round(100.0 * wins / nullif(played, 0), 1)
  from qualifying
  order by rank
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

-- Grants: the OLD single-arg overload stays in place if PostgREST called it,
-- but drop it to be safe — the client uses the new signature and defaults.
drop function if exists public.leaderboard(int);

revoke all on function public.leaderboard(int, int) from public, anon;
grant execute on function public.leaderboard(int, int) to authenticated;

comment on function public.leaderboard is
  'Top players by wins over completed matches, with a minimum play threshold. '
  'Guests cannot call it (grant is to authenticated only). Only matches with '
  'status=complete count; the RPC never returns wallet_address or trust flags.';
