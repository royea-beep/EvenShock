# Compliance evidence pack

What a supplier can demonstrate, with the mechanism named and the measurement
attached. Everything below is reproducible against a running deployment; the
tooling ships with the software.

**Provenance:** every figure was measured on the reference deployment
(`qgnxppzchqwpwerajhlu`, devnet) on the dates given. None was measured on a
licensee's deployment. Re-run them on yours before relying on them.

---

## 1. Game fairness — the server cannot change its mind

**Mechanism.** Commit-reveal. Before a player moves, the server draws its move,
stores it with a 32-byte nonce, and returns only `sha256(move:nonce)`. The move
sits in a column the client has no read grant on. When the player submits, the
server reveals both, and the client re-hashes and compares against the digest it
was handed *before* it moved.

**Why it is not merely a policy.** A server that swapped its move after seeing
the player's would produce a hash that no longer matches the digest already in
the player's hands. The client raises `FairnessError` and halts the match. This
is checked on every resolved round, not sampled.

**Evidence:** `src/data/rounds.ts` (the check), `supabase/functions/play/rules.ts`
(one shared implementation of both the hash and the outcome rules, byte-identical
on server and client, enforced by a drift test).

**Additionally**, the outcome itself is cross-checked: the client independently
computes who won from the same rule table and raises if the server disagrees.

## 2. No side channel at round open

A regulator's version of this question is "can a player learn anything they
should not, before committing". The adaptive opponent decides whether to read
the player *before* the player throws, which creates a possible timing channel.

**Measured 2026-08-14**, 235 samples:

| | |
|---|---|
| rounds where the opponent read the player | 74, mean 361.3 ms |
| rounds it threw blind | 161, mean 381.2 ms |
| difference | **−19.9 ms** (95% CI −45.2 to +5.4) |
| mutual information | 0.01137 bits |
| permutation test, 2000 shuffles | p = 0.309 |
| minimum detectable effect | **36.1 ms** |

**Stated honestly: this is a bound, not a clean bill.** It rules out any leak
larger than ~36 ms. The specific leak guarded against — skipping a database
round trip — would plausibly be 3–15 ms, below this run's resolution. The
difference is also negative, i.e. the opposite direction to the hypothesis.

A source-level test (`nemesisConstantWork.test.ts`) additionally asserts the
mitigation is still in the deployed code and is mutation-checked. Command:
`npm run e2e:nemesis-timing`.

## 3. Chip conservation — the ledger cannot leak

**Invariant:** `minted = players + house`, checked continuously and exposed in
the owner digest. Every chip that exists was created by a classified minting
reason; every chip a player holds is the sum of their ledger rows.

**Current state:** minted 2133, players 2132, house 1, **gap 0**.

**Supporting controls:**
- The ledger is append-only. A `BEFORE DELETE` trigger refuses deletion of any
  ledger or house-ledger row unless a documented authorization is set in the
  same transaction, and audits every authorized deletion with the full row.
  It binds the service role too — that is the point.
- Credits are idempotent by `idem_key`, so a retried request cannot double-pay.
- Mint classification is a table, not a list in code, and
  `ledger_reasons_unclassified()` reports any reason nobody has classified.
  **This control was added after it caught a real break**: a new bonus opened
  the identity by exactly its own value because the mint list was hand-kept in
  two places. Found by proving the change rather than trusting it.

## 4. Collusion and chip-dumping

Regulators name chip-dumping specifically as a risk suppliers are expected to
address. It is detected, not merely disclaimed.

`detect_abuse()` produces findings across:

| Detector | What it looks for |
|---|---|
| `collusion_suspected` | Pairs who play each other far more than the population, with lopsided outcome flow — the shape of one account feeding another. |
| `self_play_suspected` | One person on both sides, by device and timing correlation. |
| `rating_farming` | Rating extracted through repeated wins against the same low-rated opponent. |

Findings are written to the integrity log with the evidence attached, and
`apply_abuse_findings()` acts on them. Detection is per-pair and population-
relative rather than threshold-on-volume, so a genuinely popular pairing is not
punished for being popular.

**Also relevant:** tournament settlement carries its own conservation check with
a `no_overpay` assertion. In a deliberate breach test the global identity alone
would *not* have caught an inflated pool — only `no_overpay` did. That is why
both exist.

## 5. Geographic enforcement

Enforced in the database inside `geo_allows_money`, which every payment path
calls — not in the client, and not in the Edge Function, so it cannot be routed
around by a modified client.

- **Fails closed.** No geolocation verdict, a null country, or a datacenter/VPN
  IP all refuse.
- **Blocklist is data** (`geo_blocklist`), with a reason per row.
- **Master switch** (`feature_flags.geo_blocking`) ships **ON**; a missing row
  also reads as on, so a partial restore refuses money rather than taking it.
- **Every purchase that only succeeded because the switch was off** writes a
  `geo_bypassed` event naming the country and amount, so "what got through" is
  a query rather than a reconstruction.
- **Every flip of the switch** writes a `feature_flag_audit` row with the actor
  and timestamp. A compliance story that assumes the control was on is
  falsifiable against that table.

**Current reference-deployment state: OFF**, deliberately, for purchase-path
testing on devnet. It is a non-negotiable ON item in the mainnet activation
checklist, at the same tier as point-in-time recovery.

**Limits, stated:** IP geolocation is a compliance signal, not a security
control. A determined user tunnelling through a permitted country defeats it,
and carrier egress can place a mobile player in the wrong country.

## 6. Integrity log

`integrity_events` records fairness failures the client observed, refused
purchases, rate limiting, settlement anomalies, abuse findings and geo bypasses.
Each row carries the user, source (`client` or `server` — client reports are
recorded as claims, never as fact), and a JSON detail payload.

**A control on the control:** `integrity_kinds_unlogged()` compares the event
kinds the code emits against the kinds the table permits, by reading function
bodies. It exists because two geo event kinds were silently rejected by a
constraint for their entire life — the logging call looked correct and the write
was swallowed. It returns zero today.

## 7. Auditability of configuration

Every operator-controlled behaviour change leaves a row: feature flags
(`feature_flag_audit`), Nemesis difficulty (`nemesis_config_log`), authorized
ledger deletions. The question a regulator asks is not "is it configured
correctly now" but "was it configured correctly then", and only history answers
that.

## 8. Skill measurement

The product measures player skill directly — predictability, read rate, and a
Glicko-2 rating validated against the published worked example. A separate
document (`docs/predominance-test.md`) records what has and has not been
established about skill predominating over chance, including the fact that the
head-to-head test **cannot currently be run for lack of players**. It is
included in this pack deliberately: a supplier who only hands over favourable
measurements is not a supplier a regulator can rely on.
