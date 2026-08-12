# Pre-launch hardening — design

Nothing in this document enables real money. Devnet stays the default and the
only reachable mode. This is the shape the mainnet flag would activate, written
before it holds a cent.

Four decisions are argued here and nothing is built yet: the geo signal, the
ToS/age gate shape, treasury custody, and the checklist structure.

---

## 0. Three findings that change the design

**a. Nothing in this system can spend from the treasury — verified, not assumed.**
There is no keypair, no `secretKey`, no signing path anywhere in
`supabase/functions/` or in the client's payment code. The only signer in the
entire purchase flow is the *player's* browser wallet; the treasury address
appears in exactly two roles — a value frozen into a payment intent, and a
value compared against `postTokenBalances` when reading a transaction. The
server observes deposits. It cannot originate a transfer, and there is no code
to remove to keep it that way.

This is the single most important fact for custody, and it collapses most of
decision 3: **the application never needs the treasury key.** Custody becomes
an operations question, not an architecture question.

**b. Two value-moving actions are not rate limited.** `confirm_payment` has a
bucket defined in `take_rate_token` (60/min, 600/hr) that **nothing ever
takes** — `credit_purchase` does not call it. `record_tos_acceptance` has
neither a bucket nor a call. A defined-but-unused limit is worse than a missing
one, because a checklist that greps for the bucket name finds it and ticks the
box.

**c. The no-off-ramp claim and geo-blocking are in tension, and counsel should
see that.** The structural claim is that chips never convert to money — which
in most jurisdictions makes this a virtual-goods purchase rather than gambling.
Geo-blocking Israel and the US is a hedge on top of that claim. Both can be
true at once, but they are not the same posture, and blocking a jurisdiction
can be read as a view about which regime applies. I am not the person to
resolve that. It is flagged here so the question reaches the lawyer as a
question rather than as an assumption baked into code.

---

## 1. Geo-blocking — the signal, and fail-closed

### What signal

There is no trustworthy country header available to us. The app is static files
on a cPanel host; the value-moving code runs in Supabase Edge Functions, which
do not surface a verified client country. So the country has to be derived from
the request IP.

**Recommendation: resolve country server-side from the request IP, store the
verdict as a row, and enforce on the stored verdict.**

    request IP  ->  country lookup  ->  geo_verdicts(user_id, country, source,
                                        list_version, decided_at, allowed)

Three properties make this worth the round trip:

- **The client never supplies the country.** A header or body field naming a
  jurisdiction is a request, not a fact. The lookup happens where the value
  moves.
- **The verdict is auditable.** "Why was this account allowed to stake on the
  4th?" is answerable from a row that records the country, the source, and the
  version of the blocklist in force at that moment. Without the row, the answer
  is a re-derivation against today's list, which is not the same question.
- **It is cacheable.** One lookup per user per day (or per IP change) rather
  than one per action, which keeps it off the hot path — `mp_state` is polled
  about once a second and must not carry a geo lookup.

### Accuracy, honestly

| | reality |
|---|---|
| Fixed broadband, country level | ~95–99% correct |
| Mobile carriers | materially worse — carrier egress can be in another country from the handset |
| CGNAT / IPv6 transition | worse again |
| VPN or proxy | **defeated entirely, by design of the VPN** |
| Datacenter / hosting ASN | reliably identifiable *as* a datacenter, which is the useful signal |

IP geolocation is a **compliance signal, not a security control**. It
demonstrates that we took reasonable steps to keep play out of blocked
jurisdictions. It does not stop a determined person, and any document that
implies otherwise is wrong. The honest framing for the auditor: *we block the
casual case and record the attempt; we do not claim to defeat a VPN.*

One cheap, honest improvement: treat a **known datacenter ASN as `unknown`**
rather than as its apparent country. Commercial VPN egress is overwhelmingly
datacenter-hosted, so this converts the most common evasion into the
fail-closed branch without pretending to identify the user's real location.

### Fail-open or fail-closed

**Fail-closed for stakes. Fail-open for free play.** The asymmetry decides it:

- Failing **open** when geo is unknown means a player in a blocked jurisdiction
  stakes money. The cost lands on them — potentially an offence — and on us.
- Failing **closed** when geo is unknown means a legitimate player cannot stake
  until the lookup succeeds. The cost is an annoyed player who can still play
  the bot game, free tables, and the shop.

Those are not comparable costs, and the recommendation follows from that rather
than from caution as a temperament. `unknown` and `blocked` therefore produce
the *same* answer at the stake surface and different copy: "we couldn't confirm
where you are" is a different sentence from "stakes aren't available in your
country", and the player deserves the true one.

### Where it is enforced

Server-side, in the RPCs that move value, not in the Edge Function wrapper and
never in the UI:

- `mp_create_table` and `mp_join_table` — **only when `stake > 0`**
- `create_payment_intent` — buying chips is a money surface too
- the UI hides the stake picker as a courtesy, and that is all it is

### The blocklist is config

    create table geo_blocklist (
      country_code text primary key,      -- ISO-3166-1 alpha-2
      reason       text not null,
      blocks       text not null,         -- 'stakes' | 'all'
      added_at     timestamptz not null default now(),
      active       boolean not null default true
    );

Seeded with `IL` and `US`. Adding a jurisdiction is an INSERT — reviewable, dated,
with a reason, and no deploy. The list carries a version (max `added_at`, or an
explicit counter) so a verdict row can record which list it was decided under.

### Free play vs stake play — the split, and what it costs

Agreed: **the bot game and free tables stay open; stakes are gated.** The
problem the split creates is worth naming rather than discovering:

1. **Free multiplayer is still two humans playing a game of chance.** It is not
   gambling without consideration — nobody wagers anything — but if counsel's
   view is that the *whole product* is problematic in a jurisdiction, gating
   only stakes will not satisfy them. The `blocks` column above exists for
   exactly that: a country can be marked `all` rather than `stakes` without a
   schema change.
2. **A blocked player can still buy chips unless purchases are gated too.**
   Buying chips that can only be spent on stakes they cannot place would be a
   trap. So `create_payment_intent` is gated with the stake surfaces, not
   separately.
3. **The boundary must be the server's notion of "stake", not the UI's.** A
   free table and a 10-chip table differ by one column; the gate keys on
   `stake_chips > 0` inside the same transaction that seats the player.

---

## 2. Terms, age gate, and the no-off-ramp statement

**Recommendation: a blocking acknowledgement at first stake, plus a permanent
line on the stake surfaces. Both, with different jobs.**

The argument for the blocking modal over a checkbox: what we would want to
produce later is not "the interface displayed a term" but "this person, on this
date, was shown this text and actively agreed to it." A checkbox next to a
button is evidence that a button was pressed. A modal that stops the flow,
states the three claims, and requires an explicit action per claim is evidence
that the claims were put in front of them. The cost is one interruption, once,
at the moment real value first moves — which is the moment it is least
objectionable and most relevant.

The argument against a global age wall stands: a bot game with no money in it
does not need one, and an age wall on the front door would be friction applied
where there is nothing to protect.

### What is acknowledged

Three claims, separately, in a normal person's language:

1. **I am 18 or older.**
2. **Chips have no cash value.** They cannot be withdrawn, cannot be converted
   to money, cannot be exchanged for goods, and are only spent inside the game.
3. **Money paid for chips is not refundable as money.** Chips in, never out.

Claim 2 is the one the entire legal posture rests on, so it is the one set in
the largest type, stated first in the ToS body, and repeated on every stake
surface — the create screen, the join screen, and the purchase modal. It is
already on two of those; the audit will confirm all three.

### How it is recorded

Reuse `tos_acceptances` exactly as the purchase flow does, plus one column:

    alter table tos_acceptances add column context text not null default 'purchase';
      -- 'purchase' | 'stake'

Version + timestamp + user + context. A version bump re-triggers the gate; that
is the mechanism that makes "which text did they agree to" answerable rather
than reconstructed.

### Where it is enforced

Server-side in `mp_create_table` and `mp_join_table` when `stake > 0`, refusing
with `tos_required` and the version — the same shape `create_payment_intent`
already uses. The modal is the UI's rendering of a refusal the server issues.

---

## 3. Treasury architecture — shape, not a key

### The finding that shapes it

The system is **receive-only, structurally**. Confirmed above: no signing path
exists. Therefore the application needs the treasury *address* and nothing else,
and the key can live anywhere that never touches this codebase.

That is the whole design. Everything below is about where a human keeps a key
the software cannot reach.

### Custody options, honestly

| Option | What it is | Good | Bad |
|---|---|---|---|
| **Hot key in a Supabase secret** | Private key in env, reachable by a function | Trivial; enables automated outflows | Anything that can read env can drain it. A compromised dependency, a leaked service key, a misconfigured function. **Wrong for real money at any scale**, and we do not even need the capability |
| **Hardware wallet (Ledger/Trezor)** | Key in a device, signs when a human plugs it in | Cheap; strong against remote compromise; matches receive-only perfectly | Single device, single human — loss, theft, bus factor. Needs a documented seed backup, which becomes the real attack surface |
| **Multisig (e.g. Squads on Solana)** | m-of-n approvals, on-chain policy | No single person can move funds; survives losing one key; auditable on chain | Setup complexity; every signer needs their own key hygiene; recovery must be rehearsed before it is needed |
| **Qualified custodian** | A regulated third party holds it | Insurance, compliance posture, someone else's audited controls | Cost; counterparty risk; KYC on the entity; slowest to move funds |

**For this system specifically:** because nothing automated ever needs to sign,
the hot-key option buys us nothing and costs us everything. The realistic
choice is hardware for a solo operator, multisig the moment more than one
person is involved or the balance stops being trivial. That is a decision for
when the balance justifies the ceremony — the point of writing it now is that
the application does not care which one is chosen, and that property should be
protected rather than traded away later for convenience.

### Rotation, and why it is already config

`payment_config` holds one active row per cluster, and `create_payment_intent`
reads the treasury address from it while verification uses the intent's frozen
copy. Rotating is an INSERT of a new active row plus retiring the old — no
deploy, no cutover window, and intents quoted under the old address still
verify against the address they were quoted with. That property already exists
and the mainnet design should not break it.

### The invariant to keep

> No code path may spend from the treasury. The treasury address may appear only
> in an intent, in a balance comparison, or in a display string.

Worth a test that greps the way `runtimeAssumptions.test.ts` does: fail the
build if a signing primitive appears anywhere near the treasury address.

---

## 4. Security checklist — structure

The auditor's document is a table, not prose. One row per invariant, five
columns, and the last column is allowed to say "no".

| Path | Invariant | Enforced where | Proven by | Status |
|---|---|---|---|---|
| Purchase | A signature credits at most once | `purchases.signature` primary key | devnet replay case | done |
| Purchase | A payment credits only the payer | reference pubkey in the tx | wrong-recipient case | done |
| Stake escrow | Both stakes posted atomically with seating | `mp_escrow` inside `mp_join_table` | phase-3 suite | done |
| Stake settle | pot in = payout + rake, every path | `mp_settle` + `mp_conservation_check` | phase-3 suite, all paths | done |
| Refund | Void refunds exactly what was posted | ledger-driven refund | unjoined-table case | done |
| Rake | Whole chips only | `mp_stake_rake_must_be_whole` CHECK | stake-25 refusal | done |
| Rate limit | Every value action bounded | `take_rate_token` | — | **gap (see 0b)** |
| Geo | No stake from a blocked or unknown jurisdiction | RPC, stake surfaces | — | not built |
| ToS | No stake without a recorded 18+/no-cash-value acceptance | RPC, stake surfaces | — | not built |

Three sections follow the table:

1. **Gaps** — what is not done, in plain language, with the consequence of each.
2. **Abuse surfaces** — collusion, self-play, farming; what is covered and how.
3. **What we do not claim** — VPN evasion, mobile geolocation accuracy, and the
   fact that the server holds both moves in a multiplayer round.

### Abuse surfaces, first pass

- **Collusion between two accounts.** Covered by arithmetic rather than
  detection: chips are conserved across a stake table and the house takes a
  rake, so passing chips between two accounts you control **loses** the rake on
  every transfer. There is no configuration in which colluding is profitable.
- **Self-play.** `mp_join_table` refuses `seat_a = p_user_id`, so one account
  cannot play itself. Two accounts one person controls is the collusion case
  above — strictly loss-making.
- **Wallet farming for a signup incentive.** No signup incentive exists; a new
  account starts at zero. There is nothing to farm. This must stay true, or the
  farming analysis changes the day someone adds a welcome bonus.
- **Chip minting via bot matches.** Winning bot rounds mints chips (5/round).
  Harmless while chips never leave the game, and load-bearing on the
  no-off-ramp claim: if chips ever became sellable, this is the faucet that
  would matter. Worth stating in the checklist rather than leaving implicit.
- **Open:** no velocity monitoring on stake tables, no anomaly alerting beyond
  the owner digest, no detection of two accounts sharing an IP or a device.

---

## 5. The mainnet flag

Current state: `SOLANA_CLUSTER` and `SOLANA_RPC_URL` are function environment
variables, `loadIntent` refuses when either is absent, and a cluster mismatch
between the intent and the server is refused outright. The bones are right —
absent config already refuses rather than guesses.

What the consolidation should add:

- **One named boundary**, not four independent env vars that can drift: cluster,
  RPC URL, treasury address, USDC mint move together or not at all.
- **Fail closed on ambiguity**, not just absence: a config naming `mainnet-beta`
  with a devnet RPC, or a test mint on mainnet, must refuse. The
  `test_mint_on_mainnet` interlock already does one of these.
- **A written flip procedure**: what changes, who reviews it, what is verified
  after, and how it is reverted. The day it happens it should be a small,
  boring, reviewed change.

---

## Order of work, argued

1. **ToS and age gate.** Self-contained, no external dependency, highest legal
   value per hour, and it reuses a mechanism that already works.
2. **Geo-blocking.** Needs a decision on the lookup source (and possibly a
   small cost), so it goes second while that is settled.
3. **The mainnet flag consolidation.** Small, and it makes everything after it
   safer to touch.
4. **Treasury document.** No code; it is the artefact for the custody decision.
5. **Security audit and checklist.** Last, because it must describe the final
   state — including closing the two rate-limit gaps found in section 0b.
