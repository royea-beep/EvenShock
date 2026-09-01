-- Security lockdown: the solo game RPCs, four trigger bodies, one leaderboard,
-- and four mutable search_paths.
--
-- ROOT CAUSE, one sentence: Postgres grants EXECUTE on a new function to PUBLIC
-- by default, and these functions never revoked it. The mp_* functions did
-- (see 20260811230000: `revoke all ... from public, anon, authenticated`), so
-- multiplayer was already service-role-only. The solo path and these helpers
-- were missed, so the default PUBLIC grant stood — and PUBLIC includes anon and
-- authenticated, i.e. anyone with a login (or none) could call them over REST.
--
-- THE ONE THAT MATTERS: open_round is SECURITY DEFINER and takes the server's
-- move, nonce and commitment as CALLER-SUPPLIED parameters. With EXECUTE open to
-- authenticated, a player could call it directly via PostgREST, choose the bot's
-- move, then submit the counter through the normal path — a guaranteed win, 5
-- chips a round, and poisoned skill metrics. The whole server-authoritative
-- guarantee for solo play rests on the Edge Function being the ONLY caller, and
-- it wasn't. open_match is the same class (arbitrary match creation, rate-limit
-- and opponent-choice bypass). Both are called only by the play Edge Function as
-- service_role, so revoking anon/authenticated/PUBLIC changes nothing for
-- legitimate play — it just shuts the direct-REST door.
--
-- (resolve_round, nemesis_open, nemesis_match_report, report_integrity,
-- economy_state, spend_chips, health_digest were already service-role-only —
-- verified against the live ACLs. Only these two solo functions leaked.)

revoke all on function public.open_match(uuid, text, text, boolean, text)
  from public, anon, authenticated;
revoke all on function public.open_round(uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------- trigger bodies
--
-- These four run ONLY as trigger bodies. A trigger fires as the table's owner
-- regardless of who holds EXECUTE on the function, so revoking the direct-call
-- grant does not touch trigger behaviour — it only removes a REST endpoint that
-- should never have existed. Called directly they either error (audit/streak
-- bodies expect trigger context) or, worse, could be coaxed into writing an
-- audit/log row with attacker-chosen values; neither is a thing a caller should
-- be able to attempt.
revoke all on function public.feature_flag_audited()      from public, anon, authenticated;
revoke all on function public.nemesis_config_audit()      from public, anon, authenticated;
revoke all on function public.streak_on_match_complete()  from public, anon, authenticated;
revoke all on function public.streak_on_table_finished()  from public, anon, authenticated;
-- Same reasoning; also re-emitted below for its search_path. It only raises to
-- enforce append-only, so a direct call is harmless today — but a trigger body
-- is not an API.
revoke all on function public.rating_history_append_only() from public, anon, authenticated;

-- ------------------------------------------------------ season_leaderboard
--
-- Pure exposure: no client code calls this directly. The browser reads the
-- ladder through ladder_snapshot (a SECURITY DEFINER RPC that calls this one
-- server-side), and that panel is authenticated-only. anon EXECUTE here just
-- hands display names and ratings to any unauthenticated scanner. Locked to
-- authenticated, mirroring verify_match_integrity (20260812090000): a
-- logged-in player may query the ladder; the anonymous internet may not.
revoke all on function public.season_leaderboard(integer, integer) from public, anon;
grant execute on function public.season_leaderboard(integer, integer) to authenticated;

-- --------------------------------------------------------- mutable search_path
--
-- A function without a pinned search_path resolves unqualified names against
-- the caller's search_path, which for a SECURITY DEFINER function is a known
-- privilege-escalation vector (a caller prepends a schema shadowing an
-- unqualified reference). These four had none set. ALTER in place rather than
-- re-emit: the change is exactly "pin the path", and each body was checked to
-- be safe under the empty path — mp_escrow_guard already qualifies its one
-- reference (public.flag_enabled); the other three touch no schema objects
-- (pure arithmetic, a CASE, or a bare RAISE), so pg_catalog built-ins are all
-- they need and those resolve implicitly.
alter function public.tournament_seed_order(integer)      set search_path = '';
alter function public.mp_escrow_guard()                    set search_path = '';
alter function public.rating_history_append_only()         set search_path = '';
alter function public.rps_beats(text)                      set search_path = '';
