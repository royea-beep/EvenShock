alter table public.profiles enable row level security;
alter table public.matches  enable row level security;
alter table public.rounds   enable row level security;

-- Start from nothing. Supabase grants anon/authenticated broad table access by
-- default, and RLS is then the only thing standing between a leaked key and the
-- data. Two independent gates is the point: policies decide WHICH ROWS, grants
-- decide WHICH COLUMNS, and a mistake in one is not sufficient on its own.
revoke all on public.profiles from anon, authenticated;
revoke all on public.matches  from anon, authenticated;
revoke all on public.rounds   from anon, authenticated;

-- ---------------------------------------------------------------- profiles
-- Read your own row and no one else's. Other players' figures are reachable
-- only through public.leaderboard, which exposes a fixed column list.
create policy profiles_select_own on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- No insert policy and no delete policy, deliberately. Rows are created by the
-- identity trigger and by ensure_profile(); a client that could INSERT could
-- name its own wallet_address.
grant select on public.profiles to authenticated;

-- Column-scoped UPDATE. wallet_address, verified_at, trust_score and flags are
-- absent from this list, so they are unwritable from the client even though the
-- row-level policy says the row is yours.
grant update (display_name, preferred_theme, preferred_format, fast_mode)
  on public.profiles to authenticated;

-- ----------------------------------------------------------------- matches
create policy matches_select_own on public.matches
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy matches_insert_own on public.matches
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

grant select on public.matches to authenticated;

-- user_id and created_at are not grantable here: both take their value from a
-- default (auth.uid(), now()), so the client cannot file a match under another
-- account or backdate one.
grant insert (format, player_score, opponent_score, result, theme, fast_mode)
  on public.matches to authenticated;

-- ------------------------------------------------------------------ rounds
create policy rounds_select_own on public.rounds
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy rounds_insert_own on public.rounds
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    -- and the match really is yours, so rounds cannot be attached to someone
    -- else's match id.
    and exists (
      select 1 from public.matches m
       where m.id = match_id and m.user_id = (select auth.uid())
    )
  );

grant select on public.rounds to authenticated;
grant insert (match_id, round_number, player_choice, opponent_choice, outcome)
  on public.rounds to authenticated;

-- Matches and rounds are append-only: no update, no delete, for anyone holding
-- an anon or authenticated key. A player cannot quietly erase a losing streak.
