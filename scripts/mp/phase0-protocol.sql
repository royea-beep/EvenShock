-- Phase 0: the two-player protocol, headless, with the clocks turned down.
--
--   psql "$DATABASE_URL" -f scripts/mp/phase0-protocol.sql
--   (or paste into the SQL editor — it rolls its own results out via RAISE)
--
-- Every row of the timeout table in docs/multiplayer-design.md §2, exercised
-- without a browser, without the Edge Function, and without waiting 90 seconds
-- for anything. This is the phase the brief did not ask for and the one that
-- has already earned itself twice:
--
--   1. It caught mp_resolve writing reveal-latency into integrity_events,
--      which the kind CHECK refused — and the right fix was a separate table,
--      not a wider constraint. See 20260811190000_mp_reveal_samples.sql.
--
--   2. It caught the sweep never firing under pg_sleep. `now()` is TRANSACTION
--      START TIME in Postgres, so sleeping inside a single transaction never
--      advances the clock the sweep reads. Time-dependent logic has to be
--      tested by backdating rows, which is both correct and instant. Anything
--      that "tests" a timeout by sleeping is testing nothing.
--
-- TEARDOWN IS THE CALLER'S JOB — the script deliberately raises at the end so
-- everything rolls back, which also means it leaves no rows behind.

do $$
declare
  A uuid; B uuid; t jsonb; rid bigint; tid uuid; s text;
  -- Generated from src/utils/rules.ts. The DB looks answers up here and never
  -- knows what beats what — same discipline as the solo path.
  outcomes constant jsonb := '{"rock:rock":"tie","rock:paper":"lose","rock:scissors":"win","paper:rock":"win","paper:paper":"tie","paper:scissors":"lose","scissors:rock":"lose","scissors:paper":"win","scissors:scissors":"tie"}';
  wins constant jsonb := '{"single":1,"bo3":2,"bo5":3}';
  out_ text[] := '{}';
begin
  select id into A from auth.users order by created_at limit 1;
  select id into B from auth.users order by created_at desc limit 1;
  if A is null or A = B then raise exception 'need two distinct auth users'; end if;

  -- ================================================== the happy path
  t := public.mp_create_table(A, 'single'); tid := (t->>'table_id')::uuid;
  out_ := out_ || format('join            : seat=%s code_len=%s',
    public.mp_join_table(B, t->>'invite_code')->>'seat', length(t->>'invite_code'));

  rid := (public.mp_open_round(A, tid)->>'round_id')::bigint;
  out_ := out_ || format('open_round idem : %s (both clients may call it)',
    (public.mp_open_round(B, tid)->>'round_id') = rid::text);

  perform public.mp_commit(A, rid, 'rock', 'nonce-a', 'digest-a');

  -- THE LEAK CHECK. After A commits and before B does, nothing A can read may
  -- tell it whether B has moved. `both_committed` is symmetric and false; there
  -- is deliberately no `opponent_committed` to ask for.
  out_ := out_ || format('leak: pre-commit: both_committed=%s',
    public.mp_state(A, tid, wins) -> 'round' ->> 'both_committed');

  perform public.mp_commit(B, rid, 'scissors', 'nonce-b', 'digest-b');

  -- THE SECOND LEAK CHECK, and the one the whole protocol rests on: the FIRST
  -- revealer must learn nothing. If this ever returns the opponent's move, the
  -- second player gains a free option and every table becomes adversarial.
  out_ := out_ || format('leak: 1st reveal: payload=%s',
    public.mp_reveal(A, rid, outcomes, wins)::text);

  out_ := out_ || format('played          : %s',
    public.mp_reveal(B, rid, outcomes, wins) - 'a_nonce' - 'b_nonce');

  -- ============================================ the timeout table
  t := public.mp_create_table(A, 'bo5'); tid := (t->>'table_id')::uuid;
  perform public.mp_join_table(B, t->>'invite_code');

  -- Reveal timeout. B commits the WINNING move and refuses to reveal; it must
  -- still lose. This is the game-theoretic core: non-reveal strictly dominated.
  rid := (public.mp_open_round(A, tid)->>'round_id')::bigint;
  perform public.mp_commit(A, rid, 'rock', 'n', 'd1');
  perform public.mp_commit(B, rid, 'paper', 'n', 'd2');   -- paper beats rock
  perform public.mp_reveal(A, rid, outcomes, wins);
  update public.mp_rounds set both_committed_at = both_committed_at - interval '10 s' where id = rid;
  perform public.mp_sweep(wins);
  select format('reveal timeout  : outcome=%s resolution=%s  <- B held the winning move and lost it by not revealing',
                coalesce(outcome,'-'), coalesce(resolution,'-')) into s from public.mp_rounds where id = rid;
  out_ := out_ || s;

  -- Commit timeout: one committer beats none.
  rid := (public.mp_open_round(A, tid)->>'round_id')::bigint;
  perform public.mp_commit(B, rid, 'rock', 'n', 'd');
  update public.mp_rounds set created_at = created_at - interval '10 s' where id = rid;
  perform public.mp_sweep(wins);
  select format('commit timeout  : outcome=%s resolution=%s', coalesce(outcome,'-'), coalesce(resolution,'-'))
    into s from public.mp_rounds where id = rid;
  out_ := out_ || s;

  -- Neither commits: void and replayable, nobody scores.
  rid := (public.mp_open_round(A, tid)->>'round_id')::bigint;
  update public.mp_rounds set created_at = created_at - interval '10 s' where id = rid;
  perform public.mp_sweep(wins);
  select format('no commits      : state=%s resolution=%s', state, coalesce(resolution,'-'))
    into s from public.mp_rounds where id = rid;
  out_ := out_ || s;

  -- Neither reveals: void and replayable.
  rid := (public.mp_open_round(A, tid)->>'round_id')::bigint;
  perform public.mp_commit(A, rid, 'rock', 'n', 'x1');
  perform public.mp_commit(B, rid, 'rock', 'n', 'x2');
  update public.mp_rounds set both_committed_at = both_committed_at - interval '10 s' where id = rid;
  perform public.mp_sweep(wins);
  select format('no reveals      : state=%s resolution=%s', state, coalesce(resolution,'-'))
    into s from public.mp_rounds where id = rid;
  out_ := out_ || s;

  select format('score           : a=%s b=%s  (the two timeouts scored, the two voids did not)',
                a_score, b_score) into s from public.mp_tables where id = tid;
  out_ := out_ || s;

  -- A second sweep must be a no-op. A sweep that double-counts is how a
  -- backstop cron turns into a scoring bug.
  perform public.mp_sweep(wins);
  select format('sweep idempotent: a=%s b=%s', a_score, b_score) into s
    from public.mp_tables where id = tid;
  out_ := out_ || s;

  -- ==================================================== table lifecycle
  t := public.mp_create_table(A, 'single');
  update public.mp_tables set expires_at = now() - interval '1 s' where id = (t->>'table_id')::uuid;
  perform public.mp_sweep(wins);
  select format('table ttl       : status=%s', status) into s
    from public.mp_tables where id = (t->>'table_id')::uuid;
  out_ := out_ || s;
  out_ := out_ || format('expired join    : %s (one message for every failure — a guesser learns nothing)',
    public.mp_join_table(B, t->>'invite_code')->>'error');
  out_ := out_ || format('bad code        : %s', public.mp_join_table(B, 'ZZZZZZZZ')->>'error');

  out_ := out_ || format('latency dist    : %s', public.mp_reveal_distribution('1 hour')::text);

  -- Raising rolls the whole thing back, so the script leaves no rows behind.
  raise exception E'PHASE 0 RESULTS\n  %', array_to_string(out_, E'\n  ');
end $$;
