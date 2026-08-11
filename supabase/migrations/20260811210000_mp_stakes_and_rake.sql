-- Stake tables: escrow, settlement, and a house rake that is as traceable as
-- any player balance.
--
-- The invariant this whole file exists to hold, on EVERY path:
--
--     chips posted  =  winner payout  +  house rake        (decided)
--     chips posted  =  refunds                             (void)
--
-- Nothing is minted and nothing evaporates. Two colluding accounts passing
-- chips back and forth move value between themselves and create none; the
-- house earns only from matches that actually happened.

-- ============================================== stake sizes, structurally
--
-- "Only sizes whose rake is a whole number are valid" as a CHECK, not a
-- comment. Chips are integers: a stake whose rake works out fractional would
-- have to round, and a rounding rule is a place where chips quietly appear or
-- vanish. Better to make the bad configuration impossible to insert.
--
--   pot  = 2 * stake
--   rake = pot * rake_bps / 10000
--
-- so the rake is whole exactly when (2 * stake * rake_bps) % 10000 = 0.
--
--   stake  10 -> pot  20 -> 20*500  = 10000  -> rake  1, payout  19   OK
--   stake  50 -> pot 100 -> 100*500 = 50000  -> rake  5, payout  95   OK
--   stake 100 -> pot 200 -> 200*500 = 100000 -> rake 10, payout 190   OK
--   stake  25 -> pot  50 -> 50*500  = 25000  -> 25000 % 10000 = 5000  REFUSED
--
-- Whoever adds 25 later gets a constraint violation naming the problem, which
-- is the point: they should have to think about the half chip.
create table public.mp_stake_options (
  stake_chips bigint primary key check (stake_chips >= 0),
  rake_bps    int not null check (rake_bps between 0 and 2000),
  active      boolean not null default true,
  constraint mp_stake_rake_must_be_whole
    check ((2 * stake_chips * rake_bps) % 10000 = 0)
);

comment on constraint mp_stake_rake_must_be_whole on public.mp_stake_options is
  'Rake must divide into whole chips. A stake of 25 at 5% would rake 2.5 and is refused here rather than rounded somewhere later.';

insert into public.mp_stake_options (stake_chips, rake_bps) values
  (0,   0),      -- free tables: still a stake option, so one code path covers both
  (10,  500),
  (50,  500),
  (100, 500);

alter table public.mp_stake_options enable row level security;
revoke all on public.mp_stake_options from anon, authenticated;
-- Readable by players: the create screen has to show what the sizes cost, and
-- the rake has to be visible BEFORE anyone sits down.
create policy mp_stake_options_read on public.mp_stake_options
  for select to authenticated using (active);
grant select on public.mp_stake_options to authenticated;

-- The free-tables-only guard from Phase 1 comes off; the FK replaces it, so a
-- table can only ever name a stake the constraint above has blessed.
alter table public.mp_tables drop constraint mp_tables_stake_chips_check;
alter table public.mp_tables add constraint mp_tables_stake_is_an_option
  foreign key (stake_chips) references public.mp_stake_options (stake_chips);
alter table public.mp_tables add column rake_bps int not null default 0;
alter table public.mp_tables add column pot_chips bigint not null default 0;
alter table public.mp_tables add column rake_chips bigint not null default 0;
alter table public.mp_tables add column payout_chips bigint not null default 0;
alter table public.mp_tables add column settled_at timestamptz;
alter table public.mp_tables add column settlement text
  check (settlement in ('decided', 'void'));

-- ================================================================ the house
--
-- Rake income gets its own ledger with the same discipline as a player's: an
-- append-only row per movement, a running balance, and a UNIQUE idem_key so a
-- retried settlement cannot pay the house twice. A separate table rather than
-- a magic user id in `ledger` — inventing an auth user for the house would put
-- a login-shaped hole where an accounting record should be.
create table public.house_ledger (
  id            bigint generated always as identity primary key,
  delta         bigint not null check (delta <> 0),
  reason        text not null check (reason in ('rake')),
  table_id      uuid references public.mp_tables (id) on delete set null,
  idem_key      text not null unique,
  balance_after bigint not null,
  created_at    timestamptz not null default now()
);

create index house_ledger_time_idx on public.house_ledger (created_at desc);

alter table public.house_ledger enable row level security;
revoke all on public.house_ledger from anon, authenticated;

comment on table public.house_ledger is
  'House rake income. Same shape and same exactly-once guarantee as the player ledger — house income is not allowed to be less traceable than a player balance.';

create or replace function public.house_balance()
returns bigint language sql stable security definer set search_path = ''
as $$ select coalesce(sum(delta), 0) from public.house_ledger $$;
revoke all on function public.house_balance() from public, anon, authenticated;

-- The ledger gains the stake reasons and a multiplayer table reference, so a
-- player can see exactly which table each movement came from.
alter table public.ledger drop constraint ledger_reason_check;
alter table public.ledger add constraint ledger_reason_check
  check (reason in ('match_reward', 'theme_unlock', 'chip_purchase',
                    'stake_post', 'stake_payout', 'stake_refund'));
alter table public.ledger add column mp_table_id uuid references public.mp_tables (id) on delete set null;
create index ledger_mp_table_idx on public.ledger (mp_table_id) where mp_table_id is not null;

-- credit_ledger, extended with the table reference. Everything else is
-- unchanged, including the seed-then-update that lets it post a negative.
create or replace function public.credit_ledger(
  p_user_id  uuid,
  p_currency text,
  p_delta    bigint,
  p_reason   text,
  p_idem_key text,
  p_match_id uuid default null,
  p_sku      text default null,
  p_mp_table_id uuid default null
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_ledger_id bigint;
  v_balance   bigint;
begin
  if p_delta = 0 then return null; end if;

  insert into public.ledger (user_id, currency, delta, reason, match_id, sku, idem_key,
                             balance_after, mp_table_id)
  values (p_user_id, p_currency, p_delta, p_reason, p_match_id, p_sku, p_idem_key, 0, p_mp_table_id)
  on conflict (idem_key) do nothing
  returning id into v_ledger_id;

  if v_ledger_id is null then return null; end if;

  insert into public.balances (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  update public.balances
     set xp    = xp    + case when p_currency = 'xp'    then p_delta else 0 end,
         chips = chips + case when p_currency = 'chips' then p_delta else 0 end,
         updated_at = now()
   where user_id = p_user_id
  returning case when p_currency = 'xp' then xp else chips end into v_balance;

  update public.ledger set balance_after = v_balance where id = v_ledger_id;
  return v_balance;
end $$;
revoke all on function public.credit_ledger(uuid, text, bigint, text, text, uuid, text, uuid)
  from public, anon, authenticated;

-- =================================================================== escrow
--
-- WHY THIS CANNOT DEADLOCK — the CAPS scar, answered.
--
-- Two players can be racing to join each other's tables at the same instant:
-- A joins B's table while B joins A's. Both transactions need row locks on
-- BOTH players' balances. If transaction 1 takes A then B, and transaction 2
-- takes B then A, each holds what the other needs and Postgres kills one after
-- a deadlock timeout — under load, at settlement, which is the worst possible
-- place to discover it.
--
-- The fix is a TOTAL ORDER on lock acquisition: every transaction everywhere
-- locks balance rows in ascending user_id. A cycle needs two transactions
-- holding locks in opposite orders, and if every transaction sorts, no such
-- pair can exist. This is a proof, not a mitigation.
--
-- The ordering is computed with least()/greatest() and returned in the result
-- so a test can ASSERT it rather than trust it — see scripts/mp/phase3-stakes.sql,
-- which calls the escrow with the seats both ways round and checks the lock
-- order came out identical.
create or replace function public.mp_escrow(p_table_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  t public.mp_tables;
  v_first uuid; v_second uuid;
  v_bal_a bigint; v_bal_b bigint;
  v_pot bigint; v_rake bigint;
begin
  select * into t from public.mp_tables where id = p_table_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if t.seat_b is null then return jsonb_build_object('error', 'no_opponent'); end if;

  if t.stake_chips = 0 then
    return jsonb_build_object('ok', true, 'free', true, 'pot', 0);
  end if;

  -- Already escrowed? The idem keys make a second call a no-op, but returning
  -- early keeps the lock footprint small on a retry.
  if exists (select 1 from public.ledger
              where mp_table_id = t.id and reason = 'stake_post') then
    return jsonb_build_object('ok', true, 'already_escrowed', true, 'pot', t.pot_chips);
  end if;

  -- THE TOTAL ORDER. Both locks, ascending, always.
  v_first  := least(t.seat_a, t.seat_b);
  v_second := greatest(t.seat_a, t.seat_b);
  perform 1 from public.balances where user_id = v_first  for update;
  perform 1 from public.balances where user_id = v_second for update;

  select coalesce(chips, 0) into v_bal_a from public.balances where user_id = t.seat_a;
  select coalesce(chips, 0) into v_bal_b from public.balances where user_id = t.seat_b;

  -- No debt, ever. If either player cannot cover, the match does not start and
  -- nothing at all is posted — there is no half-staked state to clean up.
  if coalesce(v_bal_a, 0) < t.stake_chips or coalesce(v_bal_b, 0) < t.stake_chips then
    return jsonb_build_object(
      'error', 'insufficient_chips',
      'stake', t.stake_chips,
      'short_seat', case when coalesce(v_bal_a,0) < t.stake_chips then 'a' else 'b' end,
      'lock_order', jsonb_build_array(v_first, v_second));
  end if;

  v_pot  := 2 * t.stake_chips;
  v_rake := (v_pot * t.rake_bps) / 10000;   -- whole by construction; see mp_stake_options

  perform public.credit_ledger(t.seat_a, 'chips', -t.stake_chips, 'stake_post',
    'stake:' || t.id::text || ':' || t.seat_a::text, null, null, t.id);
  perform public.credit_ledger(t.seat_b, 'chips', -t.stake_chips, 'stake_post',
    'stake:' || t.id::text || ':' || t.seat_b::text, null, null, t.id);

  update public.mp_tables
     set pot_chips = v_pot, rake_chips = v_rake, payout_chips = v_pot - v_rake
   where id = t.id;

  return jsonb_build_object('ok', true, 'pot', v_pot, 'rake', v_rake,
                            'payout', v_pot - v_rake,
                            'lock_order', jsonb_build_array(v_first, v_second));
end $$;
revoke all on function public.mp_escrow(uuid) from public, anon, authenticated;

-- =============================================================== settlement
--
-- One function, both endings, and the same idem keys either way — so a table
-- can be settled decided OR void but never both, and never twice.
create or replace function public.mp_settle(p_table_id uuid, p_kind text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  t public.mp_tables;
  v_winner uuid; v_loser uuid; v_first uuid; v_second uuid;
  v_house bigint;
begin
  select * into t from public.mp_tables where id = p_table_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if t.settled_at is not null then
    return jsonb_build_object('ok', true, 'already_settled', t.settlement);
  end if;

  if t.stake_chips = 0 then
    update public.mp_tables set settled_at = now(), settlement = p_kind where id = t.id;
    return jsonb_build_object('ok', true, 'free', true);
  end if;

  -- Same total order as mp_escrow. Settlement touches the same two rows, so it
  -- has to sort by the same rule or it reintroduces the cycle escrow avoided.
  v_first  := least(t.seat_a, t.seat_b);
  v_second := greatest(t.seat_a, t.seat_b);
  perform 1 from public.balances where user_id = v_first  for update;
  perform 1 from public.balances where user_id = v_second for update;

  if p_kind = 'decided' then
    if t.result is null then return jsonb_build_object('error', 'no_result'); end if;
    v_winner := case when t.result = 'a' then t.seat_a else t.seat_b end;
    v_loser  := case when t.result = 'a' then t.seat_b else t.seat_a end;

    perform public.credit_ledger(v_winner, 'chips', t.payout_chips, 'stake_payout',
      'payout:' || t.id::text || ':' || v_winner::text, null, null, t.id);

    if t.rake_chips > 0 then
      insert into public.house_ledger (delta, reason, table_id, idem_key, balance_after)
      values (t.rake_chips, 'rake', t.id, 'rake:' || t.id::text, 0)
      on conflict (idem_key) do nothing;
      -- balance_after is written after the insert so it reflects the row's own
      -- position in the running total rather than a value computed before it.
      select public.house_balance() into v_house;
      update public.house_ledger set balance_after = v_house
       where idem_key = 'rake:' || t.id::text;
    end if;

  elsif p_kind = 'void' then
    -- The house does not earn from a match that never happened. Full refund,
    -- both sides, no rake — stated as an explicit branch rather than a rake of
    -- zero, so nobody later "simplifies" it into taking a cut.
    perform public.credit_ledger(t.seat_a, 'chips', t.stake_chips, 'stake_refund',
      'refund:' || t.id::text || ':' || t.seat_a::text, null, null, t.id);
    perform public.credit_ledger(t.seat_b, 'chips', t.stake_chips, 'stake_refund',
      'refund:' || t.id::text || ':' || t.seat_b::text, null, null, t.id);
  else
    return jsonb_build_object('error', 'bad_kind');
  end if;

  update public.mp_tables
     set settled_at = now(), settlement = p_kind,
         status = 'finished', closed_at = coalesce(closed_at, now())
   where id = t.id;

  return jsonb_build_object('ok', true, 'kind', p_kind, 'pot', t.pot_chips,
    'payout', case when p_kind = 'decided' then t.payout_chips else t.stake_chips end,
    'rake', case when p_kind = 'decided' then t.rake_chips else 0 end,
    'winner', v_winner, 'house_balance', public.house_balance());
end $$;
revoke all on function public.mp_settle(uuid, text) from public, anon, authenticated;

-- ======================================================= the conservation check
--
-- Asserted the way ledger-vs-balance consistency already is, and callable for
-- one table or all of them. A settled table must satisfy:
--
--     sum(player stake movements) + house rake = 0
--
-- Read it as: every chip that went in came out, to a player or to the house,
-- and none appeared from anywhere.
create or replace function public.mp_conservation_check(p_table_id uuid default null)
returns table (table_id uuid, settlement text, posted bigint, paid bigint,
               refunded bigint, rake bigint, net bigint, conserved boolean)
language sql stable security definer set search_path = ''
as $$
  select t.id,
         t.settlement,
         coalesce(-sum(l.delta) filter (where l.reason = 'stake_post'), 0)  as posted,
         coalesce(sum(l.delta)  filter (where l.reason = 'stake_payout'), 0) as paid,
         coalesce(sum(l.delta)  filter (where l.reason = 'stake_refund'), 0) as refunded,
         coalesce((select sum(h.delta) from public.house_ledger h where h.table_id = t.id), 0) as rake,
         coalesce(sum(l.delta), 0)
           + coalesce((select sum(h.delta) from public.house_ledger h where h.table_id = t.id), 0) as net,
         (coalesce(sum(l.delta), 0)
           + coalesce((select sum(h.delta) from public.house_ledger h where h.table_id = t.id), 0)) = 0
           as conserved
    from public.mp_tables t
    left join public.ledger l on l.mp_table_id = t.id and l.reason like 'stake%'
   where (p_table_id is null or t.id = p_table_id)
     and t.stake_chips > 0
   group by t.id, t.settlement;
$$;
revoke all on function public.mp_conservation_check(uuid) from public, anon, authenticated;

-- ====================================================== create with a stake
create or replace function public.mp_create_table(p_user_id uuid, p_format text, p_stake bigint default 0)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_code text; v_row public.mp_tables; v_opt public.mp_stake_options; v_bal bigint;
begin
  if not public.take_rate_token(p_user_id, 'mp_create') then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if p_format not in ('single', 'bo3', 'bo5') then
    return jsonb_build_object('error', 'bad_request');
  end if;

  select * into v_opt from public.mp_stake_options where stake_chips = p_stake and active;
  if not found then return jsonb_build_object('error', 'bad_stake', 'stake', p_stake); end if;

  -- A soft gate only: the authoritative check is inside the escrow transaction
  -- when the second player sits. Refusing here as well means a player is told
  -- they cannot afford a table BEFORE they hand a code to a friend, rather
  -- than when the friend tries to join.
  if p_stake > 0 then
    select coalesce(chips, 0) into v_bal from public.balances where user_id = p_user_id;
    if coalesce(v_bal, 0) < p_stake then
      return jsonb_build_object('error', 'insufficient_chips', 'stake', p_stake,
                                'chips', coalesce(v_bal, 0));
    end if;
  end if;

  perform public.mp_sweep();
  update public.mp_tables set status = 'abandoned', closed_at = now()
   where seat_a = p_user_id and status = 'open';

  v_code := public.mp_new_invite_code();
  insert into public.mp_tables (invite_code, format, seat_a, expires_at, stake_chips, rake_bps)
  values (v_code, p_format, p_user_id,
          now() + make_interval(secs => public.mp_ms('table_ttl') / 1000.0),
          p_stake, v_opt.rake_bps)
  returning * into v_row;

  return jsonb_build_object('ok', true, 'table_id', v_row.id, 'invite_code', v_row.invite_code,
    'format', v_row.format, 'status', v_row.status, 'expires_at', v_row.expires_at, 'seat', 'a',
    'stake', v_row.stake_chips, 'pot', 2 * v_row.stake_chips,
    'rake', (2 * v_row.stake_chips * v_row.rake_bps) / 10000,
    'payout', 2 * v_row.stake_chips - (2 * v_row.stake_chips * v_row.rake_bps) / 10000);
end $$;
revoke all on function public.mp_create_table(uuid, text, bigint) from public, anon, authenticated;
drop function if exists public.mp_create_table(uuid, text);

-- ============================================== join, seat, escrow, or undo
create or replace function public.mp_join_table(p_user_id uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_row public.mp_tables; v_esc jsonb;
begin
  if not public.take_rate_token(p_user_id, 'mp_join') then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  perform public.mp_sweep();

  select * into v_row from public.mp_tables
   where invite_code = upper(p_code) and p_user_id in (seat_a, seat_b)
     and status in ('open', 'playing');
  if found then
    return jsonb_build_object('ok', true, 'table_id', v_row.id, 'status', v_row.status,
      'format', v_row.format, 'already_seated', true, 'stake', v_row.stake_chips,
      'pot', v_row.pot_chips, 'rake', v_row.rake_chips, 'payout', v_row.payout_chips,
      'seat', case when v_row.seat_a = p_user_id then 'a' else 'b' end);
  end if;

  update public.mp_tables
     set seat_b = p_user_id, status = 'playing'
   where invite_code = upper(p_code)
     and status = 'open' and seat_b is null and seat_a <> p_user_id
     and expires_at > now()
  returning * into v_row;

  if not found then
    return jsonb_build_object('error', 'table_unavailable');
  end if;

  -- Escrow in the SAME transaction as the seating. If either player cannot
  -- cover, the seat is given back and the table reopens — there is no state in
  -- which a match exists half-staked, and none in which a player is seated at
  -- a table they could not afford.
  v_esc := public.mp_escrow(v_row.id);
  if v_esc ? 'error' then
    update public.mp_tables set seat_b = null, status = 'open' where id = v_row.id;
    return v_esc;
  end if;

  return jsonb_build_object('ok', true, 'table_id', v_row.id, 'status', v_row.status,
    'format', v_row.format, 'seat', 'b', 'stake', v_row.stake_chips,
    'pot', v_esc ->> 'pot', 'rake', v_esc ->> 'rake', 'payout', v_esc ->> 'payout');
end $$;
revoke all on function public.mp_join_table(uuid, text) from public, anon, authenticated;

-- ================================== settle the moment the result is written
--
-- Payout lands in the SAME transaction as the result, per the approved design.
-- mp_resolve is still the only place an outcome is written, so bolting
-- settlement onto its completion branch keeps that true for money as well.
create or replace function public.mp_resolve(
  p_round_id bigint, p_outcome text, p_resolution text, p_wins_needed jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r public.mp_rounds; t public.mp_tables;
  v_a int; v_b int; v_needed int; v_complete boolean; v_winner uuid; v_settle jsonb;
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
         outcome = p_outcome, resolution = p_resolution, resolved_at = now()
   where id = p_round_id;

  if r.both_committed_at is not null then
    insert into public.mp_reveal_samples (table_id, round_number, resolution, a_ms, b_ms)
    values (r.table_id, r.round_number, p_resolution,
      case when r.a_revealed_at is not null
           then extract(epoch from (r.a_revealed_at - r.both_committed_at)) * 1000 end,
      case when r.b_revealed_at is not null
           then extract(epoch from (r.b_revealed_at - r.both_committed_at)) * 1000 end);
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

  if v_complete then
    -- Decided by play, or by a forfeit once commitments existed. Either way a
    -- match happened, so the house earns.
    v_settle := public.mp_settle(t.id, 'decided');
  end if;

  return jsonb_build_object('ok', true, 'outcome', p_outcome, 'resolution', p_resolution,
    'score', jsonb_build_object('a', v_a, 'b', v_b),
    'match_complete', v_complete, 'winner', v_winner, 'settlement', v_settle);
end $$;
revoke all on function public.mp_resolve(bigint, text, text, jsonb) from public, anon, authenticated;

-- ==================================== voiding a match resolves escrow too
--
-- Every abandonment path ends here, and every one of them refunds in full.
-- The house does not earn from a match that never happened.
create or replace function public.mp_void_match(p_table_id uuid, p_why text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_settle jsonb;
begin
  update public.mp_tables set status = 'abandoned', closed_at = now()
   where id = p_table_id and status in ('open', 'playing');
  update public.mp_rounds set state = 'void', resolution = coalesce(resolution, 'void_no_commits'),
         resolved_at = now()
   where table_id = p_table_id and state in ('open', 'committed');
  v_settle := public.mp_settle(p_table_id, 'void');
  return jsonb_build_object('ok', true, 'why', p_why, 'settlement', v_settle);
end $$;
revoke all on function public.mp_void_match(uuid, text) from public, anon, authenticated;

-- The sweep gains match-level voiding, because with a pot on the table a stuck
-- match is locked chips rather than a stale row.
create or replace function public.mp_sweep(p_wins_needed jsonb default '{}'::jsonb)
returns int language plpgsql security definer set search_path = ''
as $$
declare v_n int := 0; v_c int; v_row record;
begin
  update public.mp_tables set status = 'abandoned', closed_at = now()
   where status = 'open' and expires_at < now();
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  for v_row in
    select id,
           case when a_committed_at is not null and b_committed_at is null then 'a'
                when b_committed_at is not null and a_committed_at is null then 'b'
                else null end as who,
           (a_committed_at is null and b_committed_at is null) as silent
      from public.mp_rounds
     where state = 'open'
       and created_at < now() - make_interval(secs => public.mp_ms('commit_window') / 1000.0)
  loop
    perform public.mp_resolve(v_row.id, v_row.who,
      case when v_row.silent then 'void_no_commits' else 'commit_timeout' end, p_wins_needed);
    v_n := v_n + 1;
  end loop;

  for v_row in
    select id,
           case when a_revealed_at is not null and b_revealed_at is null then 'a'
                when b_revealed_at is not null and a_revealed_at is null then 'b'
                else null end as who,
           (a_revealed_at is null and b_revealed_at is null) as silent
      from public.mp_rounds
     where state = 'committed'
       and both_committed_at < now() - make_interval(secs => public.mp_ms('reveal_window') / 1000.0)
  loop
    perform public.mp_resolve(v_row.id, v_row.who,
      case when v_row.silent then 'void_no_reveals' else 'reveal_timeout' end, p_wins_needed);
    v_n := v_n + 1;
  end loop;

  -- Idle matches: nothing has happened for match_idle. Void and refund.
  for v_row in
    select t.id from public.mp_tables t
     where t.status = 'playing'
       and coalesce((select max(coalesce(r.resolved_at, r.created_at))
                       from public.mp_rounds r where r.table_id = t.id), t.created_at)
           < now() - make_interval(secs => public.mp_ms('match_idle') / 1000.0)
  loop
    perform public.mp_void_match(v_row.id, 'match_idle');
    v_n := v_n + 1;
  end loop;

  -- An escrowed table that reached a terminal status without settling. Belt
  -- and braces: chips locked forever is the one outcome with no acceptable
  -- excuse, so anything that slipped through gets refunded here.
  for v_row in
    select id from public.mp_tables
     where stake_chips > 0 and settled_at is null
       and status in ('finished', 'abandoned')
  loop
    perform public.mp_settle(v_row.id,
      case when (select result from public.mp_tables where id = v_row.id) is not null
           then 'decided' else 'void' end);
    v_n := v_n + 1;
  end loop;

  return v_n;
end $$;
revoke all on function public.mp_sweep(jsonb) from public, anon, authenticated;
