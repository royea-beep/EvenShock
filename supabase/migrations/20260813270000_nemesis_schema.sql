-- NEMESIS, part 1: the schema. Config that can be turned without a deploy, the
-- mode marker, and the per-round record of what the opponent actually did.
--
-- WHAT NEMESIS IS. A second solo opponent that reads the player's bias and
-- plays the counter — but only some of the time. Today's bot draws uniformly,
-- which is why solo rounds carry no skill signal and are not rated. Nemesis
-- changes that for the only mode that currently has players.
--
-- THE FAIRNESS GUARANTEE IS INHERITED, NOT ADDED. Nemesis picks its move at
-- round OPEN, exactly where the uniform draw happens now, and the commitment
-- over (move, nonce) is handed to the client before the player moves. If
-- Nemesis peeked at the player's throw, the digest the client already holds
-- would not verify at reveal — and verifyRound checks every resolved round.
-- The proof that it cannot cheat is the commit-reveal machinery that was
-- already there.

-- ---------------------------------------------------------------- the mode
-- Recorded from day one, because "nobody picks Nemesis" is only actionable if
-- the pick rate is visible. This column IS the telemetry — no separate event.
alter table public.matches
  add column if not exists opponent text not null default 'random';
alter table public.matches drop constraint if exists matches_opponent_check;
alter table public.matches add constraint matches_opponent_check
  check (opponent in ('random', 'nemesis'));
comment on column public.matches.opponent is
  'Which solo opponent played this match. Also the mode-selection telemetry: '
  'pick rate is count(*) filter (where opponent = ''nemesis'') over the total.';

create index if not exists matches_opponent_finalized
  on public.matches (opponent, finalized_at desc) where status = 'complete';

-- --------------------------------------------------------------- the config
-- FEEL NUMBERS, NOT MATHS NUMBERS. The exploitation rate and the cold-start
-- ramp decide whether this is a worthy opponent or a hateful one, and that is
-- a judgement made by playing it, not by deriving it. They live in a table so
-- the dial can be turned between matches instead of between deploys.
--
-- Service-role only, the same posture as payment_config and feature_flags: a
-- difficulty change is an operator action with a reason attached.
create table if not exists public.nemesis_config (
  key         text primary key,
  value       numeric not null,
  description text not null,
  updated_at  timestamptz not null default now()
);
alter table public.nemesis_config enable row level security;
revoke all on public.nemesis_config from anon, authenticated;

-- A difficulty shift must never be invisible in hindsight. Without this, a
-- player's win rate changing has two indistinguishable explanations — they got
-- better, or somebody moved the dial — and the second one is unfalsifiable.
create table if not exists public.nemesis_config_log (
  id         bigint generated always as identity primary key,
  key        text not null,
  old_value  numeric,
  new_value  numeric not null,
  changed_at timestamptz not null default now()
);
alter table public.nemesis_config_log enable row level security;
revoke all on public.nemesis_config_log from anon, authenticated;
create index if not exists nemesis_config_log_time on public.nemesis_config_log (changed_at desc);

create or replace function public.nemesis_config_audit()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then
    return new;
  end if;
  insert into public.nemesis_config_log (key, old_value, new_value)
  values (new.key, case when tg_op = 'UPDATE' then old.value end, new.value);
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists nemesis_config_audited on public.nemesis_config;
create trigger nemesis_config_audited
  before insert or update on public.nemesis_config
  for each row execute function public.nemesis_config_audit();

insert into public.nemesis_config (key, value, description) values
  ('exploit_rate', 0.35,
   'How often Nemesis plays its prediction instead of throwing blind. The player''s expected score per round is 0.5 - rate * predictability / 2, so at 0 this is the uniform bot and at 1 it is a wall. 0.35 punishes a real bias inside a single bo5 while leaving a fully readable player winning about one match in six.'),
  ('ramp_start_rounds', 12,
   'Below this many lifetime resolved rounds Nemesis never exploits. A predictor with four observations that decides "you always throw rock" is both wrong and maximally visible, and a new player meeting Nemesis is the common case.'),
  ('ramp_full_rounds', 30,
   'Exploitation reaches the full rate here. Deliberately the same number as the skill-metric confidence floor: one threshold in the system, not two.'),
  ('half_life_rounds', 8,
   'Recency half-life on the predictor''s counts. Sets how fast Nemesis follows a strategy change: from a 30-round entrenched bias the prediction flips at about 12 rounds. This is the ONLY place the adaptation bound comes from.')
on conflict (key) do nothing;

create or replace function public.nemesis_setting(p_key text)
returns numeric
language sql stable parallel safe set search_path to '' as $$
  select value from public.nemesis_config where key = p_key;
$$;

-- ------------------------------------------------------ what Nemesis just did
-- WHY A SEPARATE TABLE AND NOT COLUMNS ON `rounds`. Knowing that Nemesis is
-- reading you THIS round, before you throw, is worth more than knowing its
-- move — you would simply play something else. `rounds` is already revoked
-- from authenticated, so columns there would be safe today; a separate table
-- means a future `grant select on rounds` cannot reopen the leak by accident.
--
-- Written at round OPEN alongside the move, read only by the post-match
-- feedback RPC, and only for a match that has finished.
create table if not exists public.nemesis_rounds (
  round_id     bigint primary key references public.rounds (id) on delete cascade,
  exploited    boolean not null,
  model        text,
  context      text,
  predicted    text,
  counter      text,
  ctx_weight   numeric,
  exploit_rate numeric not null,
  created_at   timestamptz not null default now()
);
alter table public.nemesis_rounds enable row level security;
revoke all on public.nemesis_rounds from anon, authenticated;
comment on table public.nemesis_rounds is
  'Per-round record of whether Nemesis read the player or threw blind, and on '
  'which model. Never client-readable while a match is live: knowing it is '
  'reading you this round is a bigger advantage than knowing its move.';
