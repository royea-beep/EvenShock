# Pre-launch security checklist

The document to hand an auditor. One row per invariant, and the status column is
allowed to say **no**. A checklist where everything passes is a checklist that
was written to pass.

Nothing below is on mainnet. Devnet is the default and the only reachable
network; stake tables are flag-off at three independent database gates.

## Money paths

| Path | Invariant | Enforced where | Proven by | Status |
|---|---|---|---|---|
| Purchase | A signature credits at most once | `purchases.signature` primary key | devnet replay case | **done** |
| Purchase | A payment credits only the payer | reference pubkey required in the tx | wrong-recipient case | **done** |
| Purchase | Amount comes from the chain, not the client | treasury token-balance delta, BigInt | dust/overpay cases | **done** |
| Purchase | Cluster mismatch cannot verify | `loadIntent`, `play/index.ts:685` | interlock probe | **done** |
| Purchase | Treasury cannot buy from itself | `create_payment_intent` vs `payment_config` | live refusal `wallet_is_treasury` | **done** |
| Purchase | No purchase from a blocked or unknown jurisdiction | `create_payment_intent` → `geo_allows_money` | live: GB issues, IL refused, datacenter refused, no verdict refused | **done** |
| Purchase | No purchase without recorded 18+ / no-cash-value acceptance | `create_payment_intent`, `context='purchase'` | live: `tos_required` then `ISSUED` | **done** |
| Stake escrow | Both stakes posted atomically with seating | `mp_escrow` inside `mp_join_table` | phase-3 suite | **done** (path disabled) |
| Stake settle | pot in = payout + rake, exactly, every path | `mp_settle`, `mp_conservation_check` | live settled match 20/19/1/0 | **done** (path disabled) |
| Stake settle | All-or-nothing IN EFFECT: a payout that fails to land aborts the rake and the settlement | `credit_ledger_strict` in `mp_settle`/`mp_escrow` (20260813090000) | live sabotage test: forced payout no-op raised, rake 0, table unsettled, clean retry conserved | **done** |
| Refund | Void refunds exactly what was posted, never more | ledger-driven refund in `mp_settle` | unjoined-table case | **done** (path disabled) |
| Rake | Whole chips only | `mp_stake_rake_must_be_whole` CHECK | stake-25 refused | **done** (path disabled) |
| Stakes | Unreachable while flag is off | 3 DB gates + client flag | service-role attack: all refused | **done** |

## Ledger and identity

| Invariant | Enforced where | Proven by | Status |
|---|---|---|---|
| minted = players + house | `ledger` + `house_ledger`; watched in `health_digest.money` (chips only, stated currency) with per-table conservation breaches beside it | live: 1622 = 1621 + 1, gap 0, breaches 0 | **done** |
| No negative balance | `credit_ledger` seed-then-update | live: 0 rows below zero | **done** |
| Identity is a verified signature, never a request field | JWT verified against JWKS, ES256 pinned | `play/index.ts` auth block | **done** |
| No client write grant on money tables | grants: SELECT only, RLS on | live grant sweep | **done** |
| No anon-executable function | live grant sweep | 0 rows | **done** |
| A live round never discloses the opponent's move | `mp_state` shape; `verify_match_integrity` state filter | leak fix verified in deployed function | **done** |
| No silent deletion of financial history — service role included | BEFORE DELETE triggers on `ledger` + `house_ledger` (20260813130000); bypass requires a transaction-local named authorization and is audited with the full row | live: unauthorized deletes refused on both tables, authorized delete audited, test rolled back | **done** |

## Rate limits

| Action | Bucket | Status |
|---|---|---|
| `payment_intent` | 10/min, 60/hr | **done** |
| `buy` (cosmetics) | 20/min, 200/hr | **done** |
| `mp_create` / `mp_join` | 10/min, 60/hr | **done** |
| `mp_move` / `mp_state` | 60 / 240 per min | **done** |
| `accept_tos` | default 60/min | **done** |
| `confirm_payment` | bucket defined, **never taken** | **NO — see gaps** |

## Gaps, in plain language

1. **`confirm_payment` is not rate limited.** The bucket exists and nothing
   calls it. It must not be closed in `credit_purchase`, which runs *after*
   on-chain verification — a throttle there would refuse to credit money already
   irreversibly paid. It belongs at the Edge Function's entry to the confirm
   action, before verification. **Consequence:** a caller can spam confirm
   attempts, costing us function invocations and RPC calls. Not a fund-loss
   vector.
2. **The geo resolver is not built.** The gate reads `geo_verdicts`; nothing
   populates it from a request IP. **Consequence:** every purchase currently
   refuses with `geo_unknown` — fail-closed working, but the control is
   structural rather than operational until the resolver lands.
3. **The mainnet boundary is four independent env vars**, not one named unit.
   `SOLANA_CLUSTER`, `SOLANA_RPC_URL`, treasury and mint can in principle drift
   apart. Absent config already refuses (`payments_unconfigured`, 503) and a
   cluster mismatch refuses (409), so it fails closed today — but nothing
   *structurally* prevents a half-configured mainnet.
4. **No treasury-signing lint.** The receive-only property is verified by
   inspection, not enforced by a test.
5. **No velocity monitoring or anomaly alerting** beyond the owner digest. No
   detection of two accounts sharing an IP or device.
6. **The stake e2e harness has never run.** Written, unrunnable from the build
   environment (no egress). The RPC layer is proven by a live settled match; the
   deployed-function layer is not.
7. **Two silent-no-op call sites remain**, audited and deferred:
   `resolve_round`'s match rewards use `perform credit_ledger` (a skip
   shortchanges a player but cannot break minted = players + house, since an
   unminted reward subtracts from both sides), and `credit_purchase` captures
   the return without checking null (reachable only if a ledger row exists for
   a signature with no payments row, which requires manual deletion). Both get
   `credit_ledger_strict` with their own tests, not in the same change as the
   settlement fix.
8. ~~The system identity is off by exactly 9 chips~~ **Repaired,
   owner-authorized, 2026-08-13** (migration
   `20260813120000_repair_0dca3e39_destroyed_rows`): the two destroyed rows
   were re-inserted under their original idem keys via `credit_ledger_strict`,
   the identity verified to close in the same transaction, and the
   `settlement_anomaly` record marked repaired. Live after: stake rows sum −1
   against house +1, identity gap 0, zero balance drift.
9. ~~Ledger durability is unenforced~~ **Enforced, in four parts
   (2026-08-13).** The BEFORE DELETE guard is
   live (20260813130000): every row on `ledger` and `house_ledger` refuses
   deletion — service role included — unless a transaction-local
   `evenshock.ledger_delete_authorization` names a reason, and authorized
   deletions are audited with the full row. It deliberately covers all rows,
   not just table-linked ones: the repaired 0dca3e39 rows carry
   `mp_table_id null`, so a linkage-keyed guard would have missed exactly
   the rows the incident taught us about. `ledger.user_id` is now
   `ON DELETE RESTRICT` (20260813140000): an account with financial history
   cannot be hard-deleted — proven live, the delete refuses with 23503 — and
   the documented erasure path is anonymise-the-profile, keep-the-rows.
   Harness resets now go through `harness_reset_user()` (20260813150000), the
   one sanctioned door: it refuses users not marked `profiles.is_harness` and
   users entangled with another player's history (stake-reason ledger rows,
   multiplayer seats or receipts), and its deletes are audited through the
   part-1 guard. Proven live: the human account refused (not harness), user1
   refused (holds the repaired stake rows — permanently unresettable, by
   design; the payment suite rotates to a fresh keypair instead), user2 reset
   cleanly with audit. Both reset scripts now call the RPC and tell the
   operator to rotate identities on refusal, never to force the wipe.
   And the identity is watched, not assumed: `health_digest.money`
   (20260813160000) reports minted/players/house, the gap, and per-table
   conservation breaches on every owner digest — the 0dca3e39 gap sat
   unnoticed for a day precisely because nothing computed it.
10. **`tos_acceptances.user_id` is still ON DELETE CASCADE.** Deleting an
   account destroys the evidence of what that person agreed to — the same
   disease as gap 9 had, legal rather than financial. Found during the FK
   sweep, deliberately not changed in the same commit as the ledger FK; it
   needs its own decision (the record may *have* to be erasable on request,
   which is exactly why it should not be decided in passing).

## Not applicable

- **Leaked-password protection (HIBP) is off in Supabase Auth, deliberately.**
  Sign-in is Sign-In-With-Solana against a wallet signature; there is no
  password field, no password reset, and no credential to appear in a breach
  corpus. Enabling it would guard a vector this product does not have, and
  would leave a later reader believing password auth exists somewhere. The
  advisor stays as an INFO note with this justification rather than being
  cleared by enabling a control for an absent surface.

## Abuse surfaces

- **Collusion between two accounts** — covered by arithmetic, not detection.
  Chips are conserved across a stake table and the house takes a rake, so moving
  chips between two accounts you control **loses** the rake every time. There is
  no configuration in which colluding is profitable.
- **Self-play** — `mp_join_table` refuses `seat_a = p_user_id`. Two accounts one
  person controls is the collusion case above: strictly loss-making.
- **Wallet farming for a signup incentive** — no signup incentive exists; a new
  account starts at zero. **This analysis expires the day someone adds a welcome
  bonus.**
- **Chip minting via bot matches** — winning rounds mint chips (5/round won).
  Harmless while chips never leave the game, and load-bearing on the
  no-off-ramp claim: if chips ever became sellable, this is the faucet that
  would matter.
- **Open:** no per-account velocity limits on stake tables; no shared-device
  detection.

## What we do not claim

- **VPN evasion is not solved.** IP geolocation is a compliance signal, not a
  security control. A determined user tunnels through an allowed country and
  this stops none of it. Datacenter-ASN detection catches the casual case only.
- **Mobile geolocation is unreliable.** Carrier egress can be in a different
  country from the handset; CGNAT makes it worse.
- **The server holds both moves** in a multiplayer round before either player
  reveals. It has to — client-held nonces turn a tab crash into a forfeit with
  a real stake on it. What the server cannot do without being caught is reveal
  something other than what it committed to: the digest binds
  `round_id:seat:move:nonce` and the client checks both seats on every resolved
  round.
- **Nothing here is a legal opinion.** The no-off-ramp claim and the geo
  blocklist are different postures and counsel should be asked which one the
  product is resting on.
