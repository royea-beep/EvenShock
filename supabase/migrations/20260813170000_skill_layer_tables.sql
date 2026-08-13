-- Skill layer, part 1 of the EVENSHOCK-SKILL-LAYER brief: the tables.
--
-- PREMISE, corrected by the owner and binding on everything here: this layer
-- exists for RETENTION — measuring skill is what gives a good player a reason
-- to come back — and as evidence counsel can examine. It is NOT permission.
-- "Skill-based" is a regulator's determination per jurisdiction, never a
-- self-declaration; every crypto skill-gaming platform operating today holds
-- a licence. stake_tables stays OFF; nothing in this layer reads or writes
-- that flag.
--
-- Derived data vs money data, and why the FK behaviors differ from ledger's:
-- every table here except the tournament ones is RECOMPUTABLE from rounds and
-- matches, so profiles FKs cascade — deleting an account may take its skill
-- rows, because they can be rebuilt and they are nobody else's history. The
-- exception is rating_history, which is append-only BY TRIGGER (same lesson
-- as the ledger guards: an audit trail that can be silently rewritten is not
-- an audit trail). Tournament rows move chips, so they get the money-table
-- treatment: RESTRICT on users, and every movement goes through the ledger.

-- ------------------------------------------------ new integrity event kinds
alter table public.integrity_events drop constraint if exists integrity_events_kind_check;
alter table public.integrity_events add constraint integrity_events_kind_check
  check (kind in ('commitment_mismatch', 'outcome_disagreement', 'reveal_before_move',
                  'move_changed_after_resolution', 'expired_round_submission',
                  'rate_limited', 'treasury_seat_voided', 'settlement_anomaly',
                  'ledger_row_deleted',
                  'collusion_suspected', 'rating_farming', 'self_play_suspected',
                  'tournament_conservation_breach', 'skill_update_failed'));

-- --------------------------------------------------------- 1. skill metrics
create table if not exists public.player_skill_metrics (
  user_id               uuid primary key references public.profiles (id) on delete cascade,
  -- 0..1. How exploitable this player's own sequence is; low is good.
  predictability_score  numeric,
  -- 0..1. How well they counter the opponent's most likely throw; high is good.
  read_score            numeric,
  matches_played        int not null default 0,
  rounds_played         int not null default 0,
  win_rate              numeric,
  -- The doc's hard rule: no rating shown under ~30 rounds. The threshold
  -- lives in the computing function; this column is what the UI reads.
  confidence            text not null default 'calibrating'
                          check (confidence in ('calibrating', 'low', 'medium', 'high')),
  last_calculated_at    timestamptz not null default now()
);
alter table public.player_skill_metrics enable row level security;
revoke all on public.player_skill_metrics from anon, authenticated;
create policy skill_metrics_own_row on public.player_skill_metrics
  for select to authenticated using (user_id = (select auth.uid()));
grant select on public.player_skill_metrics to authenticated;

-- -------------------------------------------------------------- 2. ratings
create table if not exists public.player_ratings (
  user_id          uuid primary key references public.profiles (id) on delete cascade,
  rating           numeric not null default 1500,
  rating_deviation numeric not null default 350,
  volatility       numeric not null default 0.06,
  rated_matches    int not null default 0,
  last_played_at   timestamptz,
  updated_at       timestamptz not null default now()
);
alter table public.player_ratings enable row level security;
revoke all on public.player_ratings from anon, authenticated;
create policy ratings_own_row on public.player_ratings
  for select to authenticated using (user_id = (select auth.uid()));
grant select on public.player_ratings to authenticated;

create table if not exists public.rating_history (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  rated_at         timestamptz not null default now(),
  -- 'match' = vs the bot (opponent_user_id null); 'mp_table' = vs a human.
  source           text not null check (source in ('match', 'mp_table')),
  source_id        uuid not null,
  opponent_user_id uuid,
  outcome          numeric not null check (outcome in (0, 0.5, 1)),
  rating_before    numeric not null,
  rating_after     numeric not null,
  rd_before        numeric not null,
  rd_after         numeric not null,
  volatility_after numeric not null
);
create index if not exists rating_history_user_time on public.rating_history (user_id, rated_at);
alter table public.rating_history enable row level security;
revoke all on public.rating_history from anon, authenticated;
create policy rating_history_own_rows on public.rating_history
  for select to authenticated using (user_id = (select auth.uid()));
grant select on public.rating_history to authenticated;

-- Append-only, enforced, not promised. UPDATE and DELETE both refuse — a
-- progression chart you can quietly rewrite is worth nothing as an audit.
create or replace function public.rating_history_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'rating_history is append-only: % refused on id=%', tg_op, old.id
    using errcode = 'P0001';
end $$;
drop trigger if exists rating_history_no_rewrite on public.rating_history;
create trigger rating_history_no_rewrite
  before update or delete on public.rating_history
  for each row execute function public.rating_history_append_only();

-- -------------------------------------------------------------- 3. seasons
create table if not exists public.seasons (
  id        int generated always as identity primary key,
  name      text not null,
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  status    text not null default 'upcoming' check (status in ('upcoming', 'active', 'closed')),
  check (ends_at > starts_at)
);
-- At most one active season, structurally.
create unique index if not exists seasons_one_active on public.seasons (status) where status = 'active';
alter table public.seasons enable row level security;
revoke all on public.seasons from anon, authenticated;
create policy seasons_read on public.seasons for select to authenticated using (true);
grant select on public.seasons to authenticated;

-- ---------------------------------------------------------- 4. tournaments
-- Chips only. entry fees and prizes move through the EXISTING ledger and
-- house_ledger — never a direct balance write. The flow that keeps
-- minted = players + house exact at every instant (not just at settlement):
--   register:  player -fee (ledger 'tournament_entry'), house +fee (pool)
--   settle:    house -pool, winners +prizes (ledger 'tournament_prize')
-- The pool is IN the house while the tournament runs, so the identity never
-- sees a hole the way an un-offset escrow would show one.
create table if not exists public.tournaments (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  format           text not null default 'bo5' check (format in ('single', 'bo3', 'bo5')),
  entry_fee_chips  bigint not null default 0 check (entry_fee_chips >= 0),
  prize_pool_chips bigint not null default 0 check (prize_pool_chips >= 0),
  max_players      int not null check (max_players in (2, 4, 8, 16, 32)),
  status           text not null default 'upcoming'
                     check (status in ('upcoming', 'registering', 'running', 'complete', 'cancelled')),
  season_id        int references public.seasons (id),
  starts_at        timestamptz,
  settled_at       timestamptz,
  created_at       timestamptz not null default now()
);
alter table public.tournaments enable row level security;
revoke all on public.tournaments from anon, authenticated;
create policy tournaments_read on public.tournaments for select to authenticated using (true);
grant select on public.tournaments to authenticated;

create table if not exists public.tournament_entries (
  tournament_id  uuid not null references public.tournaments (id) on delete cascade,
  -- RESTRICT, not cascade: an entry moved chips, so it is financial history.
  user_id        uuid not null references public.profiles (id) on delete restrict,
  seed           int,
  final_position int,
  prize_chips    bigint not null default 0 check (prize_chips >= 0),
  registered_at  timestamptz not null default now(),
  primary key (tournament_id, user_id)
);
create index if not exists tournament_entries_user on public.tournament_entries (user_id);
alter table public.tournament_entries enable row level security;
revoke all on public.tournament_entries from anon, authenticated;
create policy tournament_entries_read on public.tournament_entries for select to authenticated using (true);
grant select on public.tournament_entries to authenticated;

create table if not exists public.tournament_matches (
  id            bigint generated always as identity primary key,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  round_no      int not null check (round_no >= 1),
  slot          int not null check (slot >= 1),
  player_a      uuid references public.profiles (id) on delete restrict,
  player_b      uuid references public.profiles (id) on delete restrict,
  winner        uuid,
  -- The bracket slot links to the real played match. Solo (vs bot) rows have
  -- a hard FK; mp table ids are stored WITHOUT one, deliberately — swept
  -- mp_tables rows (see the 0dca3e39 sweep) would otherwise break the
  -- bracket's history. The winner column carries the result even if the
  -- table row is later gone.
  match_id      uuid references public.matches (id),
  mp_table_id   uuid,
  status        text not null default 'pending' check (status in ('pending', 'complete', 'bye')),
  unique (tournament_id, round_no, slot)
);
alter table public.tournament_matches enable row level security;
revoke all on public.tournament_matches from anon, authenticated;
create policy tournament_matches_read on public.tournament_matches for select to authenticated using (true);
grant select on public.tournament_matches to authenticated;
