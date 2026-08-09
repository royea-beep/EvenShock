-- handle_new_web3_identity is a trigger function, but PostgREST exposes every
-- function in `public`, so it was reachable at /rpc/handle_new_web3_identity by
-- anon. Calling it that way already fails ("trigger functions can only be called
-- as triggers"), so this closes an attack surface rather than a working exploit
-- -- but a SECURITY DEFINER function should never be callable by a role that
-- has no business calling it.
revoke all on function public.handle_new_web3_identity() from public, anon, authenticated;

-- ensure_profile() keeps its grant to `authenticated` deliberately: it is the
-- self-heal path for a signed-in user whose profile row is missing, and it
-- still sources the address from the verified identity rather than an argument.

-- ---------------------------------------------------------------- leaderboard
-- profiles is own-row-only, which leaves no way to show another player's name.
-- This view is that way, and the ONLY one: it is security_invoker = off, so it
-- reads past the profiles policy, and in exchange it names its columns
-- explicitly. wallet_address, trust_score, flags and verified_at are not among
-- them, and adding a column to profiles does not silently widen this view.
--
-- NOTE: superseded by 20260809115019_leaderboard_as_definer_function.sql, which
-- drops this view. Two defects, both fixed there: the losses filter tests
-- `result = 'loss'` where the check constraint spells it 'lose', and a view that
-- reads past RLS is reported at ERROR by the database linter. Kept here so
-- replaying the migrations reproduces the history rather than a tidied version
-- of it.
create or replace view public.leaderboard
with (security_invoker = off) as
  select
    row_number() over (
      order by count(*) filter (where m.result = 'win') desc,
               count(*)                                 asc,
               p.created_at                             asc
    ) as rank,
    p.id as user_id,
    -- A player who has not named themselves shows as a shortened address, the
    -- usual web3 convention. The full string is never exposed here.
    coalesce(
      nullif(p.display_name, ''),
      left(p.wallet_address, 4) || '…' || right(p.wallet_address, 4)
    ) as display_name,
    count(*)                                        as matches_played,
    count(*) filter (where m.result = 'win')        as wins,
    count(*) filter (where m.result = 'loss')       as losses,
    count(*) filter (where m.result = 'tie')        as ties,
    round(
      100.0 * count(*) filter (where m.result = 'win') / nullif(count(*), 0)
    , 1)                                            as win_rate
  from public.profiles p
  join public.matches m on m.user_id = p.id
  group by p.id, p.display_name, p.wallet_address, p.created_at;

-- Signed-in players only. anon gets nothing, here as everywhere else.
revoke all on public.leaderboard from public, anon, authenticated;
grant select on public.leaderboard to authenticated;
