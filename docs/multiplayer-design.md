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

## 1. Commitment generation: server-held pairs with signed receipts

**REVERSED from the first draft of this document, which argued for client-held
nonces. The reversal and its reason are recorded here rather than edited away,
because the first argument was not wrong — it was answering the wrong
question.**

The original argument stands on its own terms: a server that issues the nonce
can hash all three possible moves and learn the player's move immediately, so a
client-held nonce is the only way to keep the server blind. That is true, and it
is not the constraint that matters once chips are at stake.

**What matters more is crash-resilience.** A client-held nonce means the secret
that proves your move lives in `sessionStorage`. This project has already been
burned there once: storage access *throws* in private browsing, and the bug it
caused took a round that had resolved correctly and showed it as failed. Tying a
staked round to that same storage turns every tab crash, every private-browsing
session and every "clear site data" into a forfeited stake. Ideological purity
about server blindness is not worth a player losing real chips to a browser
setting.

So: **the server generates the nonce, stores the `(move, nonce)` pair, and hands
the player a signed receipt for the commitment.**

### The trade, stated honestly

The server is now in the trust base. It could, in principle, look at A's move
before B commits. That is the cost, it is real, and the answer is not to deny it
but to make it **inspectable**:

1. **The receipt is a signature over the commitment, issued before either side
   reveals.** ECDSA P-256, the same curve the Edge Function already verifies
   JWTs with. The public key is published, so the receipt is verifiable by
   anyone — not just by us.
2. **The digest binds round, player and move:**
   `sha256(round_id ‖ user_id ‖ move ‖ nonce)`. The copy attack from the first
   draft still applies with two humans and this still defeats it: a digest
   copied from A cannot be revealed by B, because B's is verified against B's
   user id.
3. **The `(move, nonce)` pair lives in a column no client has a SELECT grant
   on**, exactly as the bot path's `rounds.opponent_choice` does today.
4. **Reveal-integrity is auditable after the fact.** `verify_match_integrity(match_id)`
   re-derives every round's digest from the stored pair and compares it to the
   receipt that was signed before the reveal. If the server ever revealed
   something other than what it committed, the recomputed digest will not match
   a signature it already published, and the audit says so. "The server is in
   the trust base" then means "and here is the trail that proves it behaved",
   rather than "and you'll have to take our word for it".

The property this buys is weaker than a client-held nonce and stronger than
nothing: we cannot prove the server did not *peek*, but we can prove it did not
*change its mind* — and changing its mind is the attack that decides matches.

---

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
| Both committed, awaiting reveals | **90 s** from the *second* commitment | one silent | Revealer **wins the round outright**, whatever the moves were. The forfeiting player is told exactly that — see below | — |
| Both committed, neither reveals | 90 s | both silent | Round void, replayed | — |
| Player disconnected mid-match | 60 s from last presence heartbeat | no return | Match forfeit to the present player | Pot to them |
| Match with no activity | 10 min | — | Match void | Refund both |
| Both players idle two rounds running | — | — | Match void (draw) | Refund both |

**20 s to commit** is generous against a ~1 s decision and short enough not to
bore. **90 s to reveal** is deliberately loose for Phase 1: the reveal is a
round trip a healthy client makes in well under a second, so the window is not
sized for the happy path at all — it is sized for a player who backgrounded the
tab, lost signal in a lift, or reloaded, and it exists so that recovering costs
them nothing.

**It is also 80-odd seconds of thinking time for someone who wants it**, and I
am not going to argue about the right number without data. So the reveal
latency distribution is instrumented from the first day: every reveal records
the delay between the second commitment and the reveal landing, and
`health_digest` reports p50/p95/p99. If real humans come in at p95 under ten
seconds, the window shrinks to something with a small multiple of that, on
evidence.

### Telling the truth to whoever lost

When a round is forfeited on a missed reveal, the player who missed it sees
**why**, not a generic expiry. "Match expired" and "you did not reveal in time,
so this round went to your opponent" are the same event and completely
different messages, and the second is the one that lets a player understand what
happened to them. The forfeiting side's copy names the timeout, names the
consequence, and does not imply a fault on our side.

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
   list or create — **plus a cron backstop**. I originally wrote "no cron"; §7
   explains why the caps-poker review changed my mind, and why today's stuck
   payment intent is the same lesson at small scale.
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

---

## 7. What caps-poker taught, and what I am not taking from it

Reviewed `royea-beep/caps-poker` for the four things asked: the seating schema,
pot escrow, realtime, and scars. The scars turned out to be worth more than the
design, exactly as predicted — and one of the four questions has an answer
nobody expected.

### The headline: there is no pot escrow to compare against

The brief assumed caps-poker had solved this. It has not. There is no pot, no
escrow, and no two-sided settlement anywhere in it. Chips move through one RPC:

```ts
record_hand_net(p_device_id, p_net) -> { ok, new_balance, net, clamped }
```

**The client reports its own net result.** The server clamps it to ±10000 and
dedups on `(device_id, hand_id)`, and that is the entire integrity story for a
hand's chips. Clamping bounds the damage from a lie; it does not detect one.

So §3 of this document has no prior art to borrow, and the honest thing is to
say so rather than dress up a pattern that does not exist. Our escrow —
stake-in-the-same-transaction, payout-in-the-same-transaction-as-the-result,
conservation asserted per match — is new work, and it is also the single
biggest divergence between the two projects.

### 1. Seating schema — not borrowing it, and the reason is the scars

caps-poker has `game_rooms` + `room_players(seat_index, is_host, device_id)`
with a denormalised `current_players` counter. That shape is right for N seats.
It is wrong for two, and its own migration history says why:

- **Seat collision after a leave.** `join_table` originally assigned
  `seat_index = current_players`. Two players in seats 0 and 1; seat 0 leaves;
  `current_players` is 1; the next joiner gets seat 1 — colliding with the
  sitting player. The fix in the hardening migration is a `generate_series`
  scan for *"smallest unused seat in [0, max_players) — never collides after a
  leave"*.
- **The counter desyncs.** `leave_table` clamps with `GREATEST(0, current_players - v_deleted)`,
  and a clamp against negatives is a scar by itself. The RLS lockdown migration
  spells out the mechanism: a `players_leave_own` DELETE policy let a client
  delete its roster row directly, bypassing the decrement, *"leaving a room that
  reads FULL with an empty seat: un-joinable and un-startable."*

**What we do instead: two columns.** `tables.seat_a` and `tables.seat_b`, both
`uuid references auth.users`. Claiming a seat is one conditional update:

```sql
update tables set seat_b = p_user_id
 where id = p_table_id and seat_b is null and seat_a <> p_user_id
```

No roster table, no counter to desync, no seat index to collide, no host
election, and "is this player seated" is `auth.uid() in (seat_a, seat_b)` — a
column comparison rather than a join, which matters because it is also the
Realtime RLS policy. Both scars above are not fixed so much as **made
unreachable**: there is no structure left for them to live in.

### 2. Abandonment — I am changing my position on cron

caps-poker ends rooms with `finish_table`, called by the host client. It did not
hold. The migration comment on `cleanup_expired_rooms` says it was *"Hardened in
Phase 3 to self-heal stale 'playing' rooms"*, and the sweep now force-finishes
any room still `playing` two hours after it started, on `pg_cron` every 2
minutes.

§5 of this document originally said "no cron: a sweeper that silently stops is
worse than one that runs when it is needed." **That was wrong for anything
holding escrow**, and I want to be specific about why I changed my mind rather
than quietly editing it:

- An opportunistic sweep only runs when *someone comes back*. The whole failure
  mode of an abandoned staked match is that nobody comes back.
- We proved this on ourselves the same day. The stuck payment intent found this
  session sat `pending` past its expiry precisely because
  `expire_stale_intents` was called only from `create_payment_intent` — the
  action of a player who had already given up. Same shape, smaller stakes.

So: **opportunistic sweep for promptness, cron backstop for the ones nobody
returns to.** A cron that stops is a monitoring problem; chips locked forever is
a support problem, and the second is worse. The backstop needs its own alarm —
a `stale_escrow_count` in the health digest, so a silent cron is visible.

Also adopting their **terminal-state purge**: delete finished tables after a day
so the lobby table stays small. Tables only — matches are history and stay.

### 3. Realtime — their channel authorization never met reality

The question was whether their channel authorization survived contact with
reality. It did not, because there is none to survive: **no `private: true`
anywhere in the codebase.** Every channel is public, which means every RLS
policy on `realtime.messages` is inert by construction.

What that costs them, in `hooks/useRealtimeGame.ts`:

```ts
// Hand directed to this player
ch.on('broadcast', { event: `hand:${playerName}` }, ...)
```

Hole cards are broadcast on a public channel and "directed" to a player **by
event name**. An event name is not an access control. Anyone who knows the
session id can subscribe to `caps:game:<sessionId>`, listen for
`hand:<any player name>`, and read every player's cards. The dealing is
client-side too — `dealCards` runs on whichever client is host — so the trust
model is inverted from ours end to end.

The most instructive part is not the bug. It is that their own
`MULTIPLAYER_RESEARCH.md` identified both failure modes before any of it was
built:

> "Broadcast is ephemeral — if a player disconnects and reconnects, they miss
> messages (need Postgres fallback)"

> "Secret state — **Problem:** … visible to all room members. Need a server
> component to manage secrets"

The shipped code has no Postgres fallback and no server component for secrets.
**The scar is the gap between the design document and the code**, which is a
pointed thing to find while writing a design document. It is the argument for
§6's Phase 0: the protocol gets a headless test suite in the same phase it is
written, so "we knew that" cannot drift from "we did that".

Nothing here changes §4 — the channel carries doorbells with no payload — but it
raises my confidence in it considerably. This is what the alternative looks like
in production.

### 4. What I am taking

| From caps-poker | Why |
|---|---|
| **The kill-switch pattern** | `join_table` hardening ships *inert*, gated on `app_config.join_requires_session`, default false: apply → verify → flip → *"flip back instantly if it regresses"*. Rollback in seconds with no deploy. Adopting it for both the Realtime private-channel cutover and the §2 timeout durations, which are already a config table. |
| **`FOR UPDATE` before claiming a seat** | Confirms the plan against live code that has taken real concurrent joins. |
| **Idempotent join** | Re-joining returns the existing seat rather than erroring — the reconnect path gets it free. |
| **Terminal-state purge with a retention window** | Keeps the lobby table small without touching history. |
| **Cron backstop** | Position changed; see above. |

### 5. What I am deliberately not taking

| Not taking | Why |
|---|---|
| `game_rooms` + `room_players` + `current_players` | N-seat machinery, and its two worst bugs are structural. Two columns. |
| Client-supplied identity (`p_player_id uuid`) | Their own migration: *"SPOOFABLE — a caller can claim a seat as any uuid it likes"*, and *"the safety there is luck. Fixing identity is what turns that luck into a control."* Our Edge Function already derives the user from a verified JWT signature and never from the body. Nothing to adopt; this is the thing to avoid. |
| Membership-based RLS write policies | *"RLS cannot scope COLUMNS, so membership grants the WHOLE ROW"* — a seated player could rewrite `status`, `game_config`, `max_players`, or their own `seat_index`, which they note *"is a seat-swap primitive."* The client keeps zero write grants on tables, matches and rounds; every mutation goes through the Edge Function. |
| Host-authoritative anything | Dealing, state and secrets all originate on a client. The server refereeing is the entire premise here. |
| `anon` grants on lobby RPCs | Multiplayer is signed-in only, per the brief, and I am not bending that. |
| 4-character room codes | 32⁴ ≈ 1M against our 32⁸ ≈ 1.1 × 10¹². |
| `device_id` as an identity fallback | It exists there because the app runs anonymous auth. We have wallets. |

### 6. The scar I am taking most seriously

The header of `20260625000000_mp_lobby_rpcs.sql`:

> "These SECURITY DEFINER functions … were originally APPLIED LIVE via the
> Supabase MCP across the Jun-24/25 sessions and were NOT previously captured as
> repo migrations — so a fresh DB rebuild would have lacked them."

Six functions live in production and absent from the repo, found late and
back-filled by dumping `pg_get_functiondef`. That is precisely the failure this
project hit twice — once losing a migration to a container restart. Independent
confirmation that "apply now, commit later" is not a personal lapse but the
default failure of this workflow. Push before applying, every time.
