-- The economy endpoints had no ceiling at all.
--
-- `take_rate_token` was wired into open_match, open_round and submit, and then
-- economy_state, spend_chips and health_digest were added later without it. So
-- the three newest endpoints — including the one that MOVES CURRENCY — were the
-- only unrated ones. Found by noticing `rate_buckets` was empty after a real
-- session that had definitely called economy_state.
--
-- This matters more than it looks. `spend_chips` is the endpoint a paid
-- currency flows through, and an unbounded purchase endpoint is the first thing
-- worth hammering once chips cost money.
--
-- Limits are generous because none of these is reachable at speed by a person:
--   economy_state  120/min — a page load and an auth change, not a loop
--   buy             20/min — a human buying twenty cosmetics a minute is not
--                            buying cosmetics
--   health          20/min — one owner, glancing

create or replace function public.take_rate_token(p_user_id uuid, p_action text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_per_minute int;
  v_per_hour   int;
  v_minute_hits int;
  v_hour_hits   int;
begin
  case p_action
    when 'open_match'       then v_per_minute :=  30; v_per_hour :=  200;
    when 'open_round'       then v_per_minute :=  60; v_per_hour :=  600;
    when 'submit'           then v_per_minute :=  60; v_per_hour :=  600;
    when 'report_integrity' then v_per_minute :=  10; v_per_hour :=   60;
    when 'economy_state'    then v_per_minute := 120; v_per_hour := 1200;
    when 'buy'              then v_per_minute :=  20; v_per_hour :=  200;
    when 'health'           then v_per_minute :=  20; v_per_hour :=  200;
    else                         v_per_minute :=  60; v_per_hour :=  600;
  end case;

  insert into public.rate_buckets (user_id, action, bucket, window_start, hits)
  values (p_user_id, p_action, 'minute', date_trunc('minute', now()), 1)
  on conflict (user_id, action, bucket, window_start)
    do update set hits = public.rate_buckets.hits + 1
  returning hits into v_minute_hits;

  insert into public.rate_buckets (user_id, action, bucket, window_start, hits)
  values (p_user_id, p_action, 'hour', date_trunc('hour', now()), 1)
  on conflict (user_id, action, bucket, window_start)
    do update set hits = public.rate_buckets.hits + 1
  returning hits into v_hour_hits;

  delete from public.rate_buckets
   where user_id = p_user_id and window_start < now() - interval '3 hours';

  if v_minute_hits > v_per_minute or v_hour_hits > v_per_hour then
    perform public.log_integrity_event(
      p_user_id, 'rate_limited', 'server', null, null,
      jsonb_build_object(
        'action', p_action,
        'minute_hits', v_minute_hits, 'minute_limit', v_per_minute,
        'hour_hits', v_hour_hits, 'hour_limit', v_per_hour
      )
    );
    return false;
  end if;

  return true;
end $$;

revoke all on function public.take_rate_token(uuid, text) from public, anon, authenticated;

-- Rate the purchase path. The check goes FIRST, before the inventory lookup and
-- before the balance row lock, so a flood cannot hold locks while being refused.
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
  if not public.take_rate_token(p_user_id, 'buy') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  if p_price is null or p_price <= 0 then
    return jsonb_build_object('error', 'bad_request');
  end if;

  if exists (select 1 from public.inventory where user_id = p_user_id and sku = p_sku) then
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
  if not public.take_rate_token(p_user_id, 'economy_state') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

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

create or replace function public.health_digest(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_rows jsonb;
begin
  if not public.take_rate_token(p_user_id, 'health') then
    return jsonb_build_object('error', 'rate_limited');
  end if;

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
