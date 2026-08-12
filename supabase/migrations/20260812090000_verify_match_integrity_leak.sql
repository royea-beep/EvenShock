-- verify_match_integrity handed a seated player their opponent's move, live.
--
-- FOUND BY: a QA sweep for SECURITY DEFINER functions executable by `anon`.
-- The anon grant was the harmless half — the function filters on
-- `auth.uid()` being one of the seats, and anon has no uid, so an
-- unauthenticated caller got zero rows. Removing it is still right (an
-- authoritative function should not be reachable from the open internet at
-- all), but it is not what was broken.
--
-- THE LEAK. The row filter was `x.move is not null`, and a move becomes
-- non-null at COMMIT — not at reveal. `digest_input` is built as
-- `round_id : user_id : move : nonce`. So a player seated at a live table
-- could call this over REST the moment their opponent committed and read the
-- opponent's move and nonce before revealing their own.
--
-- That is the exact asymmetry the entire protocol exists to prevent. mp_state
-- refuses to say whether the opponent has moved; mp_reveal returns nothing to
-- the first revealer; the round tables have no client SELECT grant. All of
-- that was correct, and this function walked around every bit of it, because
-- it was written to answer a question about FINISHED matches and never said
-- so in SQL.
--
-- THE FIX IS THE STATE CHECK, not the grant. A resolved or void round is
-- symmetric information — both players already know both moves — so verifying
-- it discloses nothing. A live round discloses everything. One predicate is
-- the difference, and it belongs in the query rather than in the caller's
-- discipline.
create or replace function public.verify_match_integrity(p_table_id uuid)
returns table (round_number int, player text, commitment text, signature text,
               key_id text, digest_input text, matches boolean)
language sql stable security definer set search_path = ''
as $$
  select r.round_number, x.player, x.commitment, rc.signature, rc.key_id,
         r.id::text || ':' || x.user_id::text || ':' || x.move || ':' || x.nonce as digest_input,
         (rc.commitment = x.commitment) as matches
    from public.mp_rounds r
    join public.mp_tables t on t.id = r.table_id
    cross join lateral (values
      ('a', t.seat_a, r.a_move, r.a_nonce, r.a_commitment),
      ('b', t.seat_b, r.b_move, r.b_nonce, r.b_commitment)
    ) as x(player, user_id, move, nonce, commitment)
    left join public.mp_receipts rc on rc.round_id = r.id and rc.user_id = x.user_id
   where r.table_id = p_table_id
     -- THE LINE THIS MIGRATION EXISTS FOR. Only a round that is over may be
     -- inspected; a live one would be handing the caller the opponent's move.
     and r.state in ('resolved', 'void')
     and x.move is not null
     and (t.seat_a = (select auth.uid()) or t.seat_b = (select auth.uid()))
   order by r.round_number, x.player;
$$;

-- An authoritative function reachable by the unauthenticated internet is an
-- audit finding whether or not it returns rows today. A player verifying their
-- own finished match is legitimate; anon has no match to verify.
revoke execute on function public.verify_match_integrity(uuid) from anon, public;
grant execute on function public.verify_match_integrity(uuid) to authenticated;

comment on function public.verify_match_integrity(uuid) is
  'Reveal-integrity audit for a caller''s OWN table, resolved rounds only. The state filter is load-bearing: without it this discloses a live opponent''s move and nonce to the other seat.';

-- ------------------------------------------------------- trigger functions
--
-- These three are trigger bodies. Calling one directly raises "can only be
-- called as a trigger", so the grants are harmless in effect — and they are
-- still noise on the same audit page, which makes the page less useful. A
-- function nothing is supposed to call should not be callable.
-- By return type rather than by name: naming them meant guessing signatures
-- (strip_wallet_namespace takes an argument, and the first attempt failed on
-- it). Anything returning `trigger` is a trigger body by definition.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prorettype = 'trigger'::regtype
  loop
    execute format('revoke execute on function %s from anon, authenticated, public', f.sig);
  end loop;
end $$;
