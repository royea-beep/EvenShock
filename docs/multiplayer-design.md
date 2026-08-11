# Multiplayer: design

Player-vs-player over Supabase Realtime. This document answers the six marked
decisions before any code is written. Where I disagree with the brief I say so
and argue it.

---

## 0. The seam — one additive change, and here is exactly why

`useGame` takes `resolveOpponentChoice(playerChoice) => Promise<Choice>` and the
brief asks me to stop and say so if that cannot express two-phase commit.

**It can express the protocol.** Commit, wait for the opponent's commitment,
reveal, wait for theirs, return their move — all of it fits inside one call
whose promise may stay pending. Nothing about the signature needs to change.

**It cannot express the CHOREOGRAPHY**, and that is a real problem rather than a
quibble. `useGame` line 63:

```ts
revealTimer.current = setTimeout(async () => {
  const opponentChoice = await resolveOpponentChoice(choice);
```

The wind-up runs for `REVEAL_DELAY_MS` **first**, and only then is the opponent
awaited. Against the bot that is right: the request is in flight during the
wind-up and lands before it ends. Against a human it produces: pick → 870ms of
wind-up → an indefinite hold on a coil that is already fully wound → a snap
reveal whenever they get round to it. The animation is the product, and that
sequence breaks it in the one place the brief says must not be rebuilt.

**Minimal change: one optional callback, called before the wind-up starts.**

```ts
interface UseGameOptions {
  resolveOpponentChoice?: (playerChoice: Choice) => Choice | Promise<Choice>;
  /** Resolves when the round may begin its wind-up. Undefined = immediately. */
  awaitRoundReady?: () => Promise<void>;
}
```

`useGame` awaits it, then starts the reveal timer, then awaits
`resolveOpponentChoice` as it does today. Undefined by default, so the bot path
is byte-identical. The multiplayer implementation resolves it when **both**
commitments are recorded — so the wind-up starts when the round genuinely
starts, and the 870ms cadence lands exactly as it does now.

Everything before that is a "waiting for your opponent" state, which is UI and
gets its own treatment, as the brief allows.

---

## 1. Commitment generation: client-side, and the server must never see a nonce

**Decision: the client generates the nonce and computes the hash. The server
stores an opaque digest and issues the round token that scopes it.**

The brief frames this as a trade. It is not, once you follow the server-issued
nonce through: there are **three possible moves**. A server that issued the
nonce can hash all three against a player's commitment and know their move
instantly. It would take a few microseconds. That directly violates the stated
requirement that no player's move exists server-side before both commitments
are in — not as a leak, as a one-line computation.

So the nonce must be a secret the server does not hold. 32 bytes from
`crypto.getRandomValues`, exactly as the bot path already does it, only now on
the client.

### What the digest must bind

`sha256(move ‖ nonce)` — the current `computeCommitment` — is **not sufficient
for two humans**, and this is the part I most want reviewed.

**The copy attack.** If B can see A's commitment before committing, B submits
*the same digest*. B cannot reveal it — B has no nonce — but B does not need to:
B waits for A's reveal, then replays A's `(move, nonce)` as its own. The hash
matches, so the server accepts it, and B has played whatever A played. Every
round becomes a tie. It costs the attacker nothing and denies the opponent any
win, forever.

Two independent defences, and I want both:

1. **Bind the digest to the player and the round:**
   `sha256(round_id ‖ user_id ‖ move ‖ nonce)`. A digest copied from A can never
   be revealed by B, because B's digest is verified against *B's* user id. This
   is the load-bearing one — it holds even if the server leaks everything.
2. **Never release either commitment until both are recorded.** Defence in
   depth, and it costs nothing.

Binding to `round_id` additionally kills cross-round replay of a
`(commitment, reveal)` pair.

This means extending the shared `computeCommitment` rather than reusing it
as-is — a new `computeRoundCommitment(roundId, userId, move, nonce)` in
`src/utils/rules.ts`, alongside the existing one, which the bot path keeps using
unchanged. Both sides compute it from the same file, same as today.

### The cost, stated plainly

A client that loses its nonce cannot reveal, and **we cannot distinguish that
from a client refusing to reveal.** They must therefore be treated identically,
which the timeout table does: non-reveal loses the round. Mitigation is the
existing discipline — write `(round_id, move, nonce)` to `sessionStorage` via
`safeStorage` *before* the commit request goes out, so a reload recovers it.
Same pattern as `COMMITTED_KEY` today.

---

## 2. Timeouts

**Every duration below is a row in a `match_timing` config table, not a
constant.** The test suite sets them to 200ms; production uses the defaults.
Timeout behaviour that can only be tested by waiting 20 seconds does not get
tested, and this is the part of a multiplayer game that rots.

| State | Clock | Expiry | Resolution | Escrow |
|---|---|---|---|---|
| Table open, one seat | 15 min from creation | idle | Table closed | Nothing staked yet — see §3 |
| Invite code unredeemed | 30 min | — | Code dead | — |
| Round open, no commitments | 20 s from round open | both silent | Round void, replayed. Two consecutive → match void | Refund both |
| Round open, one commitment | 20 s | one silent | Silent player **forfeits the round**. Two forfeits in a match → forfeits the match | Pot to opponent on match forfeit |
| Both committed, awaiting reveals | 10 s from the *second* commitment | one silent | Revealer **wins the round outright**, whatever the moves were | — |
| Both committed, neither reveals | 10 s | both silent | Round void, replayed | — |
| Player disconnected mid-match | 60 s from last presence heartbeat | no return | Match forfeit to the present player | Pot to them |
| Match with no activity | 10 min | — | Match void | Refund both |
| Both players idle two rounds running | — | — | Match void (draw) | Refund both |

**20 s to commit** is generous against a ~1 s decision and short enough not to
bore; **10 s to reveal** is tight because no human is in that loop — the client
reveals automatically the moment it learns both commitments landed.

### Why non-reveal is strictly losing

The brief calls this the adversarial case, and it is only adversarial if the
protocol lets a player learn they lost before choosing whether to reveal. So:

> **The server holds both reveals until both have arrived.** Neither client
> receives the opponent's move — or anything derived from it — until its own
> reveal is recorded.

With that, a non-revealer has *no information*. Revealing yields win, lose or
tie. Not revealing yields a certain loss. Revealing therefore dominates, for
every player, in every position — which is what "strictly losing" has to mean to
be worth anything. Stalling remains possible but is never profitable.

The one thing that would break this is a well-meaning optimisation: releasing
A's reveal to B "since A has already committed anyway". That single change hands
B a free option and turns the whole table adversarial. It should be commented as
such at the call site.

---

## 3. Escrow

### Atomicity

Stakes are posted in the **same transaction that creates the match**. There is
no window in which a match exists half-staked, because the match row and both
ledger rows are one statement's worth of work in one function.

```
create_staked_match(table_id, stake):
  lock both balance rows FOR UPDATE, ordered by user_id
  if either balance < stake  → return 'insufficient_chips', create nothing
  insert match (status='in_progress', stake_chips, pot_chips = 2 * stake)
  credit_ledger(A, -stake, 'stake_post',  'stake:<match>:<A>')
  credit_ledger(B, -stake, 'stake_post',  'stake:<match>:<B>')
```

**Locking in user-id order is not incidental.** Two players who start two tables
against each other simultaneously will deadlock on unordered locks. A fixed
order makes that impossible.

Nothing is escrowed while a table waits for a second player — the stake is
posted at *match start*, i.e. when the second seat fills. A player sitting in an
open table has no chips locked, so an abandoned table cannot strand anything.

### Payout

In the same transaction as the result write, inside the existing
`resolve_round` when it finalises the match:

```
credit_ledger(winner, pot, 'stake_payout', 'payout:<match>:<winner>')
```

### Refund

Every void path in §2:

```
credit_ledger(each, stake, 'stake_refund', 'refund:<match>:<user>')
```

`ledger.idem_key` is already `UNIQUE`, so every one of these is exactly-once by
constraint rather than by code path — the same property the payment work relies
on.

### Conservation

New ledger reasons: `stake_post`, `stake_payout`, `stake_refund`.

**The invariant, asserted per match over every terminal path:**

```sql
sum(delta) where match_id = M and reason like 'stake%'  =  0
```

Chips in equal chips out. The pot is exactly the stakes, minus nothing, plus
nothing. Two colluding accounts passing chips back and forth move value between
themselves and **mint none** — which is what the anti-farming rule asks for.

Worth being precise about what this does and does not buy: conservation prevents
*creation*, not *transfer*. A player can still deliberately lose to move chips to
another account. That is acceptable here specifically because chips have no
off-ramp — there is no withdraw, no conversion, no redemption — so a transfer
between two accounts realises nothing. If an off-ramp ever appeared, this would
need revisiting on the same day, and that is worth writing down now.

---

## 4. Channel authorization — checked, and the answer is qualified

I checked the Supabase documentation rather than assuming. It is **not**
client-honour-system, but it is also **not** secure by default, and there are two
specific caveats worth designing around.

**It is enforced server-side** via RLS policies on `realtime.messages`, and
`realtime.topic()` is available inside the policy, so seat membership is
expressible:

```sql
create policy table_members_only on realtime.messages
for select to authenticated
using (exists (
  select 1 from public.table_seats s
   where s.user_id = (select auth.uid())
     and 'table:' || s.table_id::text = (select realtime.topic())
     and realtime.messages.extension in ('broadcast', 'presence')
));
```

**Caveat 1 — it does nothing until a dashboard setting changes.** Verbatim from
the docs: *"To enforce private channels you need to disable the 'Allow public
access' setting in Realtime Settings."* With that setting on, a client can
subscribe to a **public** channel of the same topic name and the policies never
run. This is a project-level toggle outside the migrations, which means it is
exactly the kind of thing that gets lost. It needs to be turned off and then
**verified by a test that tries to subscribe as a non-member and expects
failure** — an assertion in the repo, not a memory of clicking something.

**Caveat 2 — revocation is not prompt.** Verbatim: *"Client access policies are
cached for the duration of the connection. Your database is not queried for
every Channel message."* A player removed from a table keeps receiving
broadcasts until they reconnect or send a fresh JWT.

### So the channel carries nothing that matters

Given both caveats, the design does not depend on either being fixed:

| Broadcast | Payload |
|---|---|
| `round_opened` | `{ round_number }` |
| `both_committed` | `{ round_number }` |
| `round_resolved` | `{ round_number }` |
| `match_ended` | `{}` |

No moves, no commitments, no nonces, no scores. Every one of these is a
*doorbell*: it tells a client to go and ask Postgres, through the Edge Function,
which re-authorises from scratch. A total failure of channel authorization leaks
"something happened in some match", which an attacker could infer from timing
anyway.

Note the deliberate absence of `opponent_committed`. `both_committed` is
symmetric — it reaches both players at the same moment and tells each of them
something they already know about themselves. `opponent_committed` would be
asymmetric information, and while I cannot construct an attack from it in RPS,
the leak discipline on this project has been to not ship asymmetries and then
argue about whether they are exploitable.

---

## 5. Matchmaking anti-abuse — the minimum, and what I am leaving out

**Day one:**

1. **One open table per player.** Creating a second closes the first. This is
   the whole anti-squat story and it needs no new machinery — a partial unique
   index on `(creator_id) where status = 'open'`.
2. **Rate limits through the existing `take_rate_token`**: `create_table` 10/min,
   `join_table` 20/min, `redeem_invite` 10/min. The last one is what bounds
   invite-code guessing.
3. **Invite codes**: 8 characters from a 32-character alphabet with `0/O/1/I/l`
   removed — 32⁸ ≈ 1.1 × 10¹². Single-use, 30-minute expiry. At 10 guesses per
   minute a attacker expects to wait about 10⁵ years per code, so the rate limit
   is doing the work and the length is comfortable rather than load-bearing.
4. **Table TTL sweep**, opportunistic on the caller's own tables when they next
   list or create — the same pattern as `expire_stale_intents`, and for the same
   reason: no cron that can silently stop.
5. **Stake affordability re-checked inside the escrow transaction**, never from
   the lobby's view of the balance.

**Deliberately not day one:** reputation, ELO, abandon-rate penalties,
matchmaking queues, per-IP table limits. All of them need data we do not have,
and each is easier to design once real abuse has a shape. The five above are the
ones whose absence would be embarrassing rather than merely suboptimal.

---

## 6. Phasing — the brief's order, plus a phase before it

The brief proposes free/invite-only → open lobby → stakes. **I agree, and would
add a Phase 0.**

**Phase 0 — the protocol, headless.** Two scripted clients play a full match
through the Edge Function with no UI at all, exercising every row of the timeout
table with the clocks turned down to milliseconds. This is why §2 puts the
durations in a config table.

The argument for spending a phase on this: every bug that has cost this project
real time in the last week was a path that no test could reach — the browser
purchase flow, the storage failure, the game loop that had never run in
production. The timeout table is a dozen such paths, several adversarial, and
they are agonising to reach through a UI. Building the harness alongside the
protocol rather than after it is the lesson already paid for.

**Phase 1 — free tables, invite code only.** The seam change, the two-player
commit-reveal, the waiting-for-opponent UI, Realtime wired with signal-only
broadcasts, channel authorization verified by a test that expects a non-member
subscription to fail. Zero chips at risk, no discovery surface.

**Phase 2 — open-table lobby.** Discovery, presence, live list, the anti-abuse
five.

**Phase 3 — stakes.** Escrow, payout, refund, the conservation assertion across
every terminal path.

The ordering principle: each phase adds exactly one new class of risk — first
the protocol, then a discovery surface, then value. When something breaks, which
phase introduced it is never in question.

### Constraints carried through every phase

AA contrast on all eight themes, no overflow, reduced motion honoured, the leak
harness re-run against the two-player flow, migrations committed before they are
applied, tests extended rather than appended.
