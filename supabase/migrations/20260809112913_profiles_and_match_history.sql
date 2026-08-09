-- EvenShock player accounts.
--
-- Identity is a wallet address and nothing else: no email, no phone. The
-- address is NEVER written by the client -- see the provisioning trigger in a
-- later migration, which copies it out of auth.identities where Supabase Auth
-- put it after verifying the signature. A client-supplied address would let
-- anyone claim any wallet.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,

  -- Server-authoritative. Written only by handle_new_web3_identity().
  wallet_address text not null unique,

  -- Preferences, migrated from localStorage on first sign-in rather than
  -- discarded. Nullable so "never chose" stays distinguishable from "chose the
  -- default", which is what lets the migration know whether to overwrite.
  display_name      text,
  preferred_theme   text,
  preferred_format  text check (preferred_format in ('single', 'bo3', 'bo5')),
  fast_mode         boolean,

  -- Abuse surface, carried from the start so adding it later isn't a migration
  -- against live data. Nothing reads these yet; the leaderboard view is written
  -- to consult them so turning them on is a policy change, not a schema change.
  verified_at  timestamptz,
  trust_score  numeric not null default 0,
  flags        jsonb   not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.profiles.wallet_address is
  'Server-authoritative, copied from auth.identities.provider_id. Never client-writable.';
comment on column public.profiles.trust_score is
  'Reserved. 0 for everyone until there is a rule worth scoring against.';

create table public.matches (
  id uuid primary key default gen_random_uuid(),

  -- Defaulted rather than passed: the client is not granted INSERT on this
  -- column at all, so it cannot file a match under another account even if the
  -- RLS check were somehow wrong.
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,

  format           text not null check (format in ('single', 'bo3', 'bo5')),
  player_score     integer not null check (player_score >= 0),
  opponent_score   integer not null check (opponent_score >= 0),
  result           text not null check (result in ('win', 'lose', 'tie')),
  theme            text,
  fast_mode        boolean not null default false,

  -- Server clock, and not insertable by the client, so a run of matches cannot
  -- be backdated to look like months of play.
  created_at timestamptz not null default now()
);

create table public.rounds (
  id bigint generated always as identity primary key,
  match_id uuid not null references public.matches (id) on delete cascade,

  -- Denormalised from matches so RLS on this table is a single comparison
  -- rather than a subquery on every row read.
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,

  round_number     integer not null check (round_number >= 1),
  player_choice    text not null check (player_choice in ('rock', 'paper', 'scissors')),
  opponent_choice  text not null check (opponent_choice in ('rock', 'paper', 'scissors')),
  outcome          text not null check (outcome in ('win', 'lose', 'tie')),
  created_at       timestamptz not null default now(),

  unique (match_id, round_number)
);

create index matches_user_created_idx on public.matches (user_id, created_at desc);
create index rounds_user_idx          on public.rounds  (user_id);
create index rounds_match_idx         on public.rounds  (match_id, round_number);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();
