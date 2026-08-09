-- Two corrections to the leaderboard shipped in the previous migration.
--
-- 1. It counted `result = 'loss'`, but matches_result_check spells it 'lose'.
--    The filter matched nothing, so every player's losses read 0 while
--    matches_played still counted them -- wrong in a way that looks plausible.
--
-- 2. It was a view, and a view that reads past RLS is necessarily
--    SECURITY DEFINER, which the database linter reports at ERROR. The bypass
--    is intentional -- profiles is own-row-only, so nothing else can rank
--    players -- but a function states that intent at the definition instead of
--    hiding it in a storage parameter, and keeps the security report clean
--    enough that a real finding stands out.

drop view if exists public.leaderboard;

create or replace function public.leaderboard(p_limit int default 100)
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
  select
    row_number() over (
      order by count(*) filter (where m.result = 'win') desc,
               count(*)                                 asc,
               p.created_at                             asc
    ) as rank,
    p.id,
    -- A player who has not named themselves shows as a shortened address, the
    -- usual web3 convention. The full string is never returned.
    coalesce(
      nullif(p.display_name, ''),
      left(p.wallet_address, 4) || '…' || right(p.wallet_address, 4)
    ),
    count(*),
    count(*) filter (where m.result = 'win'),
    count(*) filter (where m.result = 'lose'),
    count(*) filter (where m.result = 'tie'),
    round(100.0 * count(*) filter (where m.result = 'win') / nullif(count(*), 0), 1)
  from public.profiles p
  join public.matches m on m.user_id = p.id
  group by p.id, p.display_name, p.wallet_address, p.created_at
  order by rank
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

-- The columns this returns are fixed and named above: wallet_address,
-- trust_score, flags and verified_at are not among them, so adding a column to
-- profiles cannot silently widen what the leaderboard exposes.
revoke all on function public.leaderboard(int) from public, anon;
grant execute on function public.leaderboard(int) to authenticated;
