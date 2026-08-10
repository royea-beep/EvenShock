-- Two virtual currencies earned by playing. No purchases, no wallet
-- transactions, nothing that converts to or from anything outside the game.
--
-- Built as if a dollar were already attached, because chips are the currency
-- that will later be purchasable and retrofitting correctness onto a live
-- balance is the worst version of this work. Three things follow from that and
-- are not negotiable later:
--
--   1. The LEDGER is authoritative. `balances` is a cache written only in the
--      same transaction as its ledger row. When a balance is wrong, the ledger
--      is the only thing that can say how it got that way.
--   2. Every credit is exactly-once BY CONSTRUCTION, not by care: `idem_key` is
--      unique, so a retried finalise or a double-tapped buy collides with the
--      index and does nothing.
--   3. Nothing client-side can write any of it. Same posture as `rounds` —
--      revoke, don't merely not-call.

-- ------------------------------------------------------------------- ledger
create table public.ledger (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  currency      text not null check (currency in ('xp', 'chips')),

  -- A zero movement is not an event. Grants of cosmetics are NOT ledger rows —
  -- they move no currency and live in `inventory` with source='grant'. Keeping
  -- this table purely monetary is what lets "sum(delta) = balance" stay a
  -- complete description of how a balance was reached.
  delta         bigint not null check (delta <> 0),

  reason        text not null check (reason in ('match_reward', 'theme_unlock')),
  match_id      uuid references public.matches (id) on delete set null,
  sku           text,

  -- Snapshot so the ledger can be audited without replaying it from zero.
  balance_after bigint not null,

  -- The exactly-once guarantee. 'reward:<match_id>:<currency>' for awards,
  -- 'unlock:<user_id>:<sku>' for purchases.
  idem_key      text not null unique
);

comment on table public.ledger is
  'Append-only and authoritative. Never UPDATE a delta and never DELETE a row: a correction is a new compensating row, so the history stays true.';

create index ledger_user_idx on public.ledger (user_id, created_at desc);

-- ----------------------------------------------------------------- balances
create table public.balances (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  -- The last line of defence. If a bug ever tries to spend more than is held,
  -- this aborts the transaction rather than storing a negative balance.
  xp         bigint not null default 0 check (xp    >= 0),
  chips      bigint not null default 0 check (chips >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.balances is
  'A cache of the ledger, written only in the same transaction as its ledger row. The ledger is the source of truth.';

-- ---------------------------------------------------------------- inventory
create table public.inventory (
  user_id     uuid not null references auth.users (id) on delete cascade,
  sku         text not null,
  acquired_at timestamptz not null default now(),
  -- 'grant' is how a theme someone was ALREADY USING stays theirs. Taking
  -- something away is worse than never having offered it.
  source      text not null check (source in ('purchase', 'grant')),
  primary key (user_id, sku)
);

-- ------------------------------------------------------------------ access
-- Read your own, write nothing. Every mutation goes through a service-role RPC.
alter table public.ledger    enable row level security;
alter table public.balances  enable row level security;
alter table public.inventory enable row level security;

revoke all on public.ledger    from anon, authenticated;
revoke all on public.balances  from anon, authenticated;
revoke all on public.inventory from anon, authenticated;

create policy ledger_select_own on public.ledger
  for select to authenticated using ((select auth.uid()) = user_id);
create policy balances_select_own on public.balances
  for select to authenticated using ((select auth.uid()) = user_id);
create policy inventory_select_own on public.inventory
  for select to authenticated using ((select auth.uid()) = user_id);

grant select on public.ledger    to authenticated;
grant select on public.balances  to authenticated;
grant select on public.inventory to authenticated;

-- Owner flag, used only by the health digest. Set by hand:
--   update public.profiles set is_owner = true where wallet_address = '...';
alter table public.profiles add column is_owner boolean not null default false;

-- ================================================================== credit
--
-- The only way currency is created.
--
-- Returns the new balance, or NULL when the idem_key was already used — which
-- is the replay case and must be a silent no-op rather than a second credit.
create or replace function public.credit_ledger(
  p_user_id  uuid,
  p_currency text,
  p_delta    bigint,
  p_reason   text,
  p_idem_key text,
  p_match_id uuid default null,
  p_sku      text default null
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ledger_id bigint;
  v_balance   bigint;
begin
  if p_delta = 0 then return null; end if;

  -- The ledger row is claimed FIRST, before any balance moves. Two concurrent
  -- identical credits both reach here; the unique index lets exactly one
  -- through and the other gets no row back, so the balance moves once. Doing
  -- this the other way round — move the balance, then try to record it — is how
  -- double-credits happen.
  insert into public.ledger (user_id, currency, delta, reason, match_id, sku, idem_key, balance_after)
  values (p_user_id, p_currency, p_delta, p_reason, p_match_id, p_sku, p_idem_key, 0)
  on conflict (idem_key) do nothing
  returning id into v_ledger_id;

  if v_ledger_id is null then
    return null; -- already credited; nothing to do
  end if;

  insert into public.balances (user_id, xp, chips)
  values (
    p_user_id,
    case when p_currency = 'xp'    then p_delta else 0 end,
    case when p_currency = 'chips' then p_delta else 0 end
  )
  on conflict (user_id) do update set
    xp    = public.balances.xp    + case when p_currency = 'xp'    then p_delta else 0 end,
    chips = public.balances.chips + case when p_currency = 'chips' then p_delta else 0 end,
    updated_at = now()
  returning case when p_currency = 'xp' then xp else chips end into v_balance;

  update public.ledger set balance_after = v_balance where id = v_ledger_id;
  return v_balance;
end $$;

revoke all on function public.credit_ledger(uuid, text, bigint, text, text, uuid, text)
  from public, anon, authenticated;

-- =================================================================== spend
--
-- Buying a cosmetic. The concurrency story matters more than anything else
-- here, so it is explicit rather than incidental:
--
--   SELECT ... FOR UPDATE takes the balance row lock up front. A second
--   simultaneous buy blocks there, and when it proceeds it re-reads the already
--   reduced balance and correctly fails. Without the lock, both requests would
--   read the same starting balance and both would pass an affordability check
--   that neither could actually satisfy — the same class of bug as replaying a
--   payment.
--
-- The ledger's unique idem_key then makes a *retry* (as opposed to a race) a
-- no-op, and the inventory primary key means it cannot be bought twice even if
-- both other guards were wrong.
create or replace function public.spend_chips(
  p_user_id uuid,
  p_sku     text,
  p_price   bigint
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chips     bigint;
  v_ledger_id bigint;
  v_balance   bigint;
begin
  if p_price is null or p_price <= 0 then
    return jsonb_build_object('error', 'bad_request');
  end if;

  if exists (select 1 from public.inventory where user_id = p_user_id and sku = p_sku) then
    -- Already owned. Not an error, and above all not a second charge.
    return jsonb_build_object('ok', true, 'already_owned', true);
  end if;

  select chips into v_chips
    from public.balances
   where user_id = p_user_id
     for update;

  if v_chips is null or v_chips < p_price then
    return jsonb_build_object('error', 'insufficient_chips',
                              'chips', coalesce(v_chips, 0), 'price', p_price);
  end if;

  insert into public.ledger (user_id, currency, delta, reason, sku, idem_key, balance_after)
  values (p_user_id, 'chips', -p_price, 'theme_unlock', p_sku,
          'unlock:' || p_user_id::text || ':' || p_sku, 0)
  on conflict (idem_key) do nothing
  returning id into v_ledger_id;

  if v_ledger_id is null then
    -- A retry of this exact purchase. The first one already paid.
    insert into public.inventory (user_id, sku, source)
    values (p_user_id, p_sku, 'purchase')
    on conflict do nothing;
    return jsonb_build_object('ok', true, 'already_owned', true);
  end if;

  update public.balances
     set chips = chips - p_price, updated_at = now()
   where user_id = p_user_id
  returning chips into v_balance;

  update public.ledger set balance_after = v_balance where id = v_ledger_id;

  insert into public.inventory (user_id, sku, source)
  values (p_user_id, p_sku, 'purchase')
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'chips', v_balance, 'sku', p_sku);
end $$;

revoke all on function public.spend_chips(uuid, text, bigint) from public, anon, authenticated;

-- ============================================================ economy state
--
-- Balances plus inventory, and the one place the "never lock what someone is
-- already using" rule is applied: a priced theme the player currently has
-- selected is granted rather than taken away. A grant moves no currency, so it
-- is an inventory row and not a ledger row.
create or replace function public.economy_state(
  p_user_id       uuid,
  p_current_theme text default null,
  p_priced        jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_xp    bigint;
  v_chips bigint;
begin
  if p_current_theme is not null
     and p_priced ? p_current_theme
     and not exists (select 1 from public.inventory where user_id = p_user_id and sku = p_current_theme)
  then
    insert into public.inventory (user_id, sku, source)
    values (p_user_id, p_current_theme, 'grant')
    on conflict do nothing;
  end if;

  insert into public.balances (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select xp, chips into v_xp, v_chips from public.balances where user_id = p_user_id;

  return jsonb_build_object(
    'xp', coalesce(v_xp, 0),
    'chips', coalesce(v_chips, 0),
    'owned', coalesce(
      (select jsonb_agg(sku order by sku) from public.inventory where user_id = p_user_id),
      '[]'::jsonb
    )
  );
end $$;

revoke all on function public.economy_state(uuid, text, jsonb) from public, anon, authenticated;

-- ================================================================== health
--
-- The integrity digest, for the owner only. Cheap on purpose: no cron, no
-- delivery path, no secrets. It exists so the answer to "is anything wrong" is
-- reachable from a phone instead of requiring someone to remember to run SQL.
create or replace function public.health_digest(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_rows jsonb;
begin
  if not exists (select 1 from public.profiles where id = p_user_id and is_owner) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', kind, 'source', source, 'events', events, 'users', users, 'latest', latest
         )), '[]'::jsonb)
    into v_rows
    from public.integrity_summary('24 hours');

  return jsonb_build_object(
    'window', '24 hours',
    'events', v_rows,
    'totals', jsonb_build_object(
      'matches_complete',   (select count(*) from public.matches where status = 'complete'),
      'matches_abandoned',  (select count(*) from public.matches where status = 'in_progress'),
      'players',            (select count(*) from public.profiles),
      -- A ledger that disagrees with a balance is the alarm that matters most
      -- once chips carry value, so it is computed here rather than trusted.
      'ledger_mismatches',  (
        select count(*) from (
          select b.user_id
            from public.balances b
            left join (
              select user_id,
                     sum(delta) filter (where currency = 'xp')    as xp,
                     sum(delta) filter (where currency = 'chips') as chips
                from public.ledger group by user_id
            ) l on l.user_id = b.user_id
           where b.xp <> coalesce(l.xp, 0) or b.chips <> coalesce(l.chips, 0)
        ) m
      )
    )
  );
end $$;

revoke all on function public.health_digest(uuid) from public, anon, authenticated;

-- ====================================================== award on completion
--
-- resolve_round gains the rates and credits the match in the SAME transaction
-- that finalises it. A match that is complete but unpaid — even for the width
-- of a crash — is exactly the failure that stops being survivable once chips
-- cost money, so there is no window in which one exists.
create or replace function public.resolve_round(
  p_round_id    bigint,
  p_user_id     uuid,
  p_player_move text,
  p_outcomes    jsonb,
  p_wins_needed jsonb,
  p_economy     jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rd public.rounds;
  m  public.matches;
  v_outcome  text;
  v_rounds   int;
  v_player   int;
  v_opponent int;
  v_needed   int;
  v_complete boolean;
  v_result   text;
  v_claimed  int;
  v_xp       bigint := 0;
  v_chips    bigint := 0;
begin
  if not public.take_rate_token(p_user_id, 'submit') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  select * into rd from public.rounds where id = p_round_id and user_id = p_user_id;
  if not found then return jsonb_build_object('error', 'not_found'); end if;

  select * into m from public.matches where id = rd.match_id;

  if rd.state = 'resolved' then
    if rd.player_choice <> p_player_move then
      perform public.log_integrity_event(
        p_user_id, 'move_changed_after_resolution', 'server', rd.match_id, rd.id,
        jsonb_build_object('recorded_move', rd.player_choice, 'attempted_move', p_player_move)
      );
      return jsonb_build_object('error', 'already_submitted');
    end if;
    v_outcome := rd.outcome;

  elsif rd.expires_at <= now() then
    perform public.log_integrity_event(
      p_user_id, 'expired_round_submission', 'server', rd.match_id, rd.id,
      jsonb_build_object('expired_at', rd.expires_at, 'late_by_seconds',
                         round(extract(epoch from (now() - rd.expires_at))))
    );
    return jsonb_build_object('error', 'round_expired');

  else
    v_outcome := p_outcomes ->> (p_player_move || ':' || rd.opponent_choice);
    if v_outcome is null then return jsonb_build_object('error', 'bad_request'); end if;

    update public.rounds
       set state = 'resolved', player_choice = p_player_move,
           outcome = v_outcome, resolved_at = now()
     where id = rd.id and state = 'open';
    get diagnostics v_claimed = row_count;

    if v_claimed = 0 then
      select * into rd from public.rounds where id = p_round_id;
      if rd.player_choice is distinct from p_player_move then
        return jsonb_build_object('error', 'already_submitted');
      end if;
      v_outcome := rd.outcome;
    end if;
  end if;

  select count(*),
         count(*) filter (where outcome = 'win'),
         count(*) filter (where outcome = 'lose')
    into v_rounds, v_player, v_opponent
    from public.rounds
   where match_id = rd.match_id and state = 'resolved';

  v_needed   := (p_wins_needed ->> m.format)::int;
  v_complete := v_player >= v_needed or v_opponent >= v_needed;
  v_result := case when v_complete then (case when v_player >= v_needed then 'win' else 'lose' end) end;

  update public.matches
     set player_score   = v_player,
         opponent_score = v_opponent,
         status         = case when v_complete then 'complete' else 'in_progress' end,
         result         = v_result,
         finalized_at   = case when v_complete then now() end
   where id = rd.match_id;

  -- Paid only on completion. An abandoned match pays nothing, which is the
  -- whole anti-farming property: quitting a match you are losing can never beat
  -- playing it out. The idem_key is derived from the match, so a retried submit
  -- on the final round credits exactly once.
  if v_complete then
    v_xp    := coalesce((p_economy ->> 'xp_per_round')::bigint, 0)        * v_rounds;
    v_chips := coalesce((p_economy ->> 'chips_per_round_won')::bigint, 0) * v_player;

    if v_xp > 0 then
      perform public.credit_ledger(p_user_id, 'xp', v_xp, 'match_reward',
                                   'reward:' || rd.match_id::text || ':xp', rd.match_id);
    end if;
    if v_chips > 0 then
      perform public.credit_ledger(p_user_id, 'chips', v_chips, 'match_reward',
                                   'reward:' || rd.match_id::text || ':chips', rd.match_id);
    end if;
  end if;

  return jsonb_build_object(
    'round_number',    rd.round_number,
    'commitment',      rd.commitment,
    'opponent_choice', rd.opponent_choice,
    'nonce',           rd.nonce,
    'outcome',         v_outcome,
    'score',           jsonb_build_object('player', v_player, 'opponent', v_opponent),
    'match_complete',  v_complete,
    'match_result',    v_result,
    'award',           case when v_complete
                            then jsonb_build_object('xp', v_xp, 'chips', v_chips)
                            else jsonb_build_object('xp', 0, 'chips', 0) end
  );
end $$;

revoke all on function public.resolve_round(bigint, uuid, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;

-- The five-argument signature is replaced by the six-argument one above.
drop function if exists public.resolve_round(bigint, uuid, text, jsonb, jsonb);
