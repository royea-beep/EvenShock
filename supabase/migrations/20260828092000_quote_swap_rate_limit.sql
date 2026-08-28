-- Rate limit for the swap quote action. The quote endpoint is a new outbound
-- dependency (Jupiter, on mainnet) sitting on a path that already carries
-- money; an unlimited quote call is a free way to burn our API quota. 15/min
-- covers a 60-second-quote refresh loop with headroom; 90/hr stops a client
-- from parking in that loop all day.
--
-- Everything except the new `quote_swap` branch is carried over byte-for-byte
-- from 20260811180000; it is re-emitted in full because plpgsql has no way to
-- patch a body.
create or replace function public.take_rate_token(p_user_id uuid, p_action text)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  v_per_minute int; v_per_hour int; v_minute_hits int; v_hour_hits int;
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
    when 'quote_swap'       then v_per_minute :=  15; v_per_hour :=   90;
    -- Multiplayer. mp_join is the one that bounds invite-code guessing, so it
    -- is the tightest of the three.
    when 'mp_create'        then v_per_minute :=  10; v_per_hour :=   60;
    when 'mp_join'          then v_per_minute :=  10; v_per_hour :=   60;
    when 'mp_state'         then v_per_minute := 240; v_per_hour := 3000;
    when 'mp_move'          then v_per_minute :=  60; v_per_hour :=  600;
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
        'hour_hits', v_hour_hits, 'hour_limit', v_per_hour));
    return false;
  end if;
  return true;
end $$;
revoke all on function public.take_rate_token(uuid, text) from public, anon, authenticated;
