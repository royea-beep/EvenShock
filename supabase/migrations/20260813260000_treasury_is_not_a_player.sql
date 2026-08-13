-- The treasury is operational identity, not a competitor.
--
-- THE THIRD DOOR. The treasury wallet was already blocked from two things, both
-- deliberately: it cannot buy chips (a purchase would be a self-transfer the
-- chain records as a zero delta) and it cannot sit at a stake table (the house
-- also holding a seat makes the books unreadable). Nobody blocked it from the
-- LADDER — and after the harness cleanup it was the only account
-- `is_rateable_player` still accepted. The one name on a competitive ranking was
-- the account that collects the house's money.
--
-- Same contamination class as the thirteen untagged harness accounts, reached
-- through a different door: an operational account whose record was never meant
-- to be a player's record.
--
-- WHY "EVER" AND NOT "ACTIVE", which is the whole point of this migration.
-- `is_treasury_wallet` matches only the CURRENTLY active row in payment_config.
-- Reusing it here would mean that the moment the treasury rotates, the old
-- address silently becomes an ordinary player — carrying its operational match
-- history and its operational chips onto the ladder with it. That is exactly
-- the retired-`fill(9)` lesson from the harness registry: an address that has
-- stopped serving a role does not stop having served it.
--
-- payment_config supports this because rotation is append-and-retire, not
-- update-in-place: a rotated row keeps its `treasury_address` with `active =
-- false` and a `retired_at`. So every address that has ever been treasury is
-- still on file, and this matches all of them.
--
-- THE TWO GUARDS ANSWER DIFFERENT QUESTIONS, and that is why both exist:
--
--   is_treasury_wallet        "would money from this wallet be a self-transfer,
--   (active only)              and would seating it make the books unreadable?"
--                              Both are about the wallet collecting house money
--                              RIGHT NOW. A retired treasury can legitimately
--                              buy chips again — the transfer is real once it is
--                              no longer paying itself — so that guard must not
--                              widen.
--
--   was_ever_treasury_wallet  "is this account's record operational rather than
--   (active or retired)        a player's?" Once true, always true.
--
-- Widening the first would break chip purchases for a rotated wallet. Narrowing
-- the second would re-admit it to the ladder. They are kept apart on purpose.

create or replace function public.was_ever_treasury_wallet(p_user_id uuid)
returns boolean
language sql stable parallel safe set search_path to '' as $$
  select exists (
    select 1
      from public.profiles p
      join public.payment_config c
        on c.treasury_address = p.wallet_address
     where p.id = p_user_id
       and p.wallet_address is not null
  );
$$;
comment on function public.was_ever_treasury_wallet(uuid) is
  'True if this account''s wallet is, or has ever been, a treasury address — '
  'active or retired. Deliberately wider than is_treasury_wallet, which asks '
  'only about the currently active treasury.';

-- One definition of who may rank, now covering all three ways an account can be
-- something other than a player: a test rig, an operator, or the house.
create or replace function public.is_rateable_player(p_user_id uuid)
returns boolean
language sql stable parallel safe set search_path to '' as $$
  select coalesce(
    (select not (p.is_harness or p.is_owner or public.was_ever_treasury_wallet(p.id))
       from public.profiles p where p.id = p_user_id),
    false
  );
$$;
comment on function public.is_rateable_player(uuid) is
  'False for harness accounts, owner accounts, any wallet that has ever been a '
  'treasury address, and any user_id with no profile. The single gate used by '
  'the rating pipeline, the season ladder and tournament registration.';

-- The ladder holds no rating for anything that is not a player. Same reasoning
-- as the harness cleanup: player_ratings is a derived cache, rebuildable from
-- rating_history, so clearing it costs nothing — and rating_history is left
-- alone, because it is append-only and its rows are true.
delete from public.player_ratings pr
 where not public.is_rateable_player(pr.user_id);
