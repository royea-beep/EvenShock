-- Reveal latency gets its own table, not a row in integrity_events.
--
-- Caught by the Phase 0 protocol test on its first run: the insert violated
-- `integrity_events_kind_check`, which was the constraint doing its job. The
-- easy fix would have been to add 'mp_reveal_latency' to the allowed kinds.
-- That would have been wrong.
--
-- `integrity_events` means SOMETHING MIGHT BE WRONG. It is what health_digest
-- summarises and what a burst in would make someone look. Reveal latency is
-- routine telemetry recorded on every single round — thousands of rows saying
-- nothing is wrong. Mixing them would drown the signal the table exists for,
-- and within a week the digest would be something nobody reads.
--
-- So: a separate table, and a percentile function for the digest to call.
-- This is the instrumentation that decides whether the 90s reveal window
-- shrinks. It is deliberately in place before the first real match rather than
-- added when the question comes up, because the question will come up as an
-- argument and the answer should be a distribution.

create table public.mp_reveal_samples (
  id          bigint generated always as identity primary key,
  table_id    uuid not null references public.mp_tables (id) on delete cascade,
  round_number int not null,
  resolution  text not null,
  -- Milliseconds from the SECOND commitment — the moment both players were
  -- waiting on each other — to each reveal landing. Null means that player
  -- never revealed, which is the timeout case and is itself the finding.
  a_ms        numeric,
  b_ms        numeric,
  recorded_at timestamptz not null default now()
);

create index mp_reveal_samples_time_idx on public.mp_reveal_samples (recorded_at desc);

alter table public.mp_reveal_samples enable row level security;
revoke all on public.mp_reveal_samples from anon, authenticated;

comment on table public.mp_reveal_samples is
  'Reveal-latency telemetry. Deliberately NOT integrity_events: that table means something might be wrong, and a per-round sample would drown it.';

create or replace function public.mp_resolve(
  p_round_id    bigint,
  p_outcome     text,
  p_resolution  text,
  p_wins_needed jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r public.mp_rounds;
  t public.mp_tables;
  v_a int; v_b int; v_needed int; v_complete boolean; v_winner uuid;
begin
  select * into r from public.mp_rounds where id = p_round_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if r.state in ('resolved', 'void') then
    return jsonb_build_object('ok', true, 'already', r.state);
  end if;

  select * into t from public.mp_tables where id = r.table_id for update;

  update public.mp_rounds
     set state = case when p_resolution in ('void_no_commits', 'void_no_reveals')
                      then 'void' else 'resolved' end,
         outcome = p_outcome,
         resolution = p_resolution,
         resolved_at = now()
   where id = p_round_id;

  -- Sampled for every round that reached two commitments, timeouts included —
  -- a round where nobody revealed is the most interesting row in the table.
  if r.both_committed_at is not null then
    insert into public.mp_reveal_samples (table_id, round_number, resolution, a_ms, b_ms)
    values (
      r.table_id, r.round_number, p_resolution,
      case when r.a_revealed_at is not null
           then extract(epoch from (r.a_revealed_at - r.both_committed_at)) * 1000 end,
      case when r.b_revealed_at is not null
           then extract(epoch from (r.b_revealed_at - r.both_committed_at)) * 1000 end
    );
  end if;

  select count(*) filter (where outcome = 'a'), count(*) filter (where outcome = 'b')
    into v_a, v_b
    from public.mp_rounds where table_id = r.table_id and state = 'resolved';

  v_needed := coalesce((p_wins_needed ->> t.format)::int, 1);
  v_complete := v_a >= v_needed or v_b >= v_needed;
  if v_complete then
    v_winner := case when v_a >= v_needed then t.seat_a else t.seat_b end;
  end if;

  update public.mp_tables
     set a_score = v_a, b_score = v_b,
         status = case when v_complete then 'finished' else status end,
         result = case when v_complete then (case when v_a >= v_needed then 'a' else 'b' end) end,
         finalized_at = case when v_complete then now() else finalized_at end,
         closed_at = case when v_complete then now() else closed_at end
   where id = t.id;

  return jsonb_build_object(
    'ok', true, 'outcome', p_outcome, 'resolution', p_resolution,
    'score', jsonb_build_object('a', v_a, 'b', v_b),
    'match_complete', v_complete, 'winner', v_winner
  );
end $$;
revoke all on function public.mp_resolve(bigint, text, text, jsonb) from public, anon, authenticated;

-- The distribution, for health_digest. Both seats pooled: the question is what
-- a human takes to reveal, not what seat A takes.
create or replace function public.mp_reveal_distribution(p_window interval default '7 days')
returns jsonb language sql stable security definer set search_path = ''
as $$
  with samples as (
    select unnest(array_remove(array[a_ms, b_ms], null)) as ms
      from public.mp_reveal_samples where recorded_at > now() - p_window
  )
  select jsonb_build_object(
    'window', p_window::text,
    'n', count(*),
    'p50', round(percentile_cont(0.5)  within group (order by ms)::numeric, 1),
    'p95', round(percentile_cont(0.95) within group (order by ms)::numeric, 1),
    'p99', round(percentile_cont(0.99) within group (order by ms)::numeric, 1),
    'max', round(max(ms)::numeric, 1),
    -- The number that decides whether the window shrinks: rounds lost because
    -- nobody revealed in time, as a share of rounds that got that far.
    'reveal_timeouts', (select count(*) from public.mp_reveal_samples
                         where recorded_at > now() - p_window
                           and resolution in ('reveal_timeout', 'void_no_reveals')),
    'window_ms', public.mp_ms('reveal_window')
  ) from samples;
$$;
revoke all on function public.mp_reveal_distribution(interval) from public, anon, authenticated;
