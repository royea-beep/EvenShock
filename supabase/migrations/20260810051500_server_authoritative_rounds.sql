-- Round outcomes move from the browser to the server.
--
-- Until now the client drew the bot's move, decided the result, and inserted
-- the row saying so. Every one of those steps was a place to type a win that
-- never happened. From here the server draws, decides and writes, and the
-- client's only remaining power over history is to read it.
--
-- The mechanism is commit-reveal, because rock-paper-scissors is simultaneous:
--   open   -- server draws its move, stores it with a random nonce, and returns
--             only sha256(move || nonce). It cannot change its move afterwards
--             without breaking that hash.
--   submit -- client sends its move. Only then does the server reveal its own
--             move and the nonce, so the player can verify the commitment.
-- The server must not learn the player's move before committing, and the client
-- must not learn the server's before committing. The schema below is what makes
-- the second half true: the nonce and the drawn move live in columns the client
-- cannot read.

-- ------------------------------------------------------------------- matches
-- A match now has a lifecycle. It is written at the start, when its result is
-- genuinely unknown, so `result` can no longer be NOT NULL.
alter table public.matches
  add column status text not null default 'in_progress'
    check (status in ('in_progress', 'complete', 'abandoned')),
  add column finalized_at timestamptz,
  alter column result drop not null,
  alter column player_score set default 0,
  alter column opponent_score set default 0;

-- A complete match must have its result and its finalization time; an
-- incomplete one must not claim either. This is what stops a half-played match
-- from being counted as anything.
alter table public.matches
  add constraint matches_complete_has_result check (
    (status = 'complete' and result is not null and finalized_at is not null)
    or (status <> 'complete' and finalized_at is null)
  );

comment on column public.matches.status is
  'in_progress until the server finalizes it. Only complete matches count anywhere.';

-- -------------------------------------------------------------------- rounds
-- A round row is created at `open`, before the player has moved, so the columns
-- describing the player''s side start empty.
alter table public.rounds
  add column commitment text not null,
  add column nonce      text not null,
  add column state      text not null default 'open'
    check (state in ('open', 'resolved')),
  add column expires_at timestamptz not null default now() + interval '60 seconds',
  add column resolved_at timestamptz,
  alter column player_choice drop not null,
  alter column outcome       drop not null;

alter table public.rounds
  add constraint rounds_resolved_is_complete check (
    (state = 'resolved'
      and player_choice is not null
      and outcome is not null
      and resolved_at is not null)
    or (state = 'open'
      and player_choice is null
      and outcome is null
      and resolved_at is null)
  );

comment on column public.rounds.opponent_choice is
  'The server''s move, drawn at open time. Secret until the round resolves — the client has no SELECT grant on this table.';
comment on column public.rounds.nonce is
  'Random per-round salt. Without it a commitment over three possible moves is brute-forced instantly.';

-- At most one unopened round per match at a time. Without this a player could
-- hold several open rounds and pick which to resolve; with it, the previous
-- round must be resolved (or expired and swept) before another can be drawn.
create unique index rounds_one_open_per_match
  on public.rounds (match_id) where state = 'open';

-- ------------------------------------------------------- client loses writes
-- The whole point. Dropping the policies alone would not be enough — a policy
-- is only consulted for a role that holds the privilege — so the grants go too.
drop policy if exists matches_insert_own on public.matches;
drop policy if exists rounds_insert_own  on public.rounds;

revoke insert on public.matches from authenticated;
revoke insert on public.rounds  from authenticated;

-- The Edge Function writes as the service role, which bypasses RLS entirely.
-- It supplies user_id explicitly: auth.uid() is null under the service role, so
-- these defaults would fail rather than silently mis-attribute a row.

-- ----------------------------------------------------- client loses ROUND reads
-- rounds now holds the server's move and the nonce for any round still open.
-- A client that can SELECT its own rounds can read the answer the moment the
-- round is drawn, which defeats the commitment completely. Nothing in the app
-- reads this table today, so the grant goes rather than being narrowed to a
-- column list that a future ALTER could quietly widen.
--
-- When a history panel needs per-round detail, add a SECURITY DEFINER function
-- returning resolved rounds only. Do not restore a table-level SELECT grant.
drop policy if exists rounds_select_own on public.rounds;
revoke select on public.rounds from authenticated;

-- matches keeps its own-row SELECT: it holds no secret, and the client renders
-- the score from it.

-- -------------------------------------------------------------- leaderboard
-- Unfinalized matches must not count, or abandoning a match you are losing
-- would be a way to keep a clean record.
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
  join public.matches m
    on m.user_id = p.id
   and m.status = 'complete'
  group by p.id, p.display_name, p.wallet_address, p.created_at
  order by rank
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

revoke all on function public.leaderboard(int) from public, anon;
grant execute on function public.leaderboard(int) to authenticated;
