insert into public.payment_config (cluster, treasury_address, usdc_mint, usdc_decimals, chips_per_usdc)
values ('devnet', 'CzVLg3pPP6sszaPxgdX8LNh8duG7r6dyQGiojeLsmAB7',
        '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 6, 100)
on conflict do nothing;

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
    when 'payment_intent'   then v_per_minute :=  10; v_per_hour :=   60;
    when 'confirm_payment'  then v_per_minute :=  60; v_per_hour :=  600;
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
      jsonb_build_object('action', p_action,
        'minute_hits', v_minute_hits, 'minute_limit', v_per_minute,
        'hour_hits', v_hour_hits, 'hour_limit', v_per_hour)
    );
    return false;
  end if;

  return true;
end $$;

revoke all on function public.take_rate_token(uuid, text) from public, anon, authenticated;

create or replace function public.open_intents_for_reconcile(p_max_age interval default '7 days')
returns table (id uuid, user_id uuid, cluster text, reference text,
               treasury_address text, usdc_mint text, chips_per_usdc int)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.user_id, i.cluster, i.reference,
         i.treasury_address, i.usdc_mint, i.chips_per_usdc
    from public.payment_intents i
   where i.status = 'pending'
     and i.created_at > now() - p_max_age
   order by i.created_at;
$$;

revoke all on function public.open_intents_for_reconcile(interval) from public, anon, authenticated;