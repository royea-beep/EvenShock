# EVENSHOCK — ADD A SKILL LAYER, RANKING, AND TOURNAMENTS

Yes, allow all edits in components.

---

## RULE #0 — NO MANUAL STEPS FOR ROYE

Try EVERY possible API/CLI/SDK/workaround before escalating anything. At least 9 different
approaches. Only escalate if ALL automated paths are genuinely impossible AND you can explain
exactly why no API exists for it.

## SPENDING RULE

FREE actions → execute autonomously. PAID actions → STOP and ask first.
Also requires approval: deploying to production, destructive/irreversible DB operations.

## SCOPE GUARD

Do NOT enable the `stake_tables` feature flag. It is intentionally `false` pending a separate
legal review of wagering on chance outcomes. Nothing in this task turns real-money staking on.
Everything below is designed to work in the free/chips-only mode that is live today.

---

## PROJECT

**Supabase project:** `qgnxppzchqwpwerajhlu` (evenshock)

Existing schema you must work with (do not recreate):
- `matches` — user_id, format (single/bo3/bo5), player_score, opponent_score, result, theme, fast_mode, status, finalized_at
- `rounds` — match_id, user_id, round_number, player_choice, opponent_choice, outcome, **commitment, nonce**, state, expires_at, resolved_at
- `profiles` — wallet_address, display_name, trust_score, flags, is_owner, is_harness, verified_at
- `balances`, `ledger` (reasons: match_reward, chip_purchase, stake_post, stake_payout), `house_ledger`
- `integrity_events` — kind + detail jsonb (already catching `move_changed_after_resolution`)
- `mp_tables`, `mp_rounds`, `mp_receipts`, `mp_stake_options`, `mp_timing`, `mp_reveal_samples`
- `feature_flags`, `payment_config`, `geo_verdicts`, `geo_blocklist`, `tos_versions`, `tos_acceptances`

---

## THE PROBLEM TO SOLVE

Rock-paper-scissors with one throw is **pure chance**. That creates two problems at once:

1. **Product problem** — you cannot build ranking, tournaments, or a competitive scene on a coin
   flip. There is no skill to reward, so there is no reason for a good player to come back.
2. **Legal problem** — wagering on a chance outcome is the exact thing that has `stake_tables`
   frozen. Skill-dominant outcomes sit in a very different and much less restricted category.

Repeated RPS against the *same opponent* is **not** pure chance. Humans cannot generate random
sequences. Real skill = detecting your opponent's bias and exploiting it while masking your own.
The `bo5` format already in production is the right substrate — it just is not being measured
as a skill game.

**Current data proves the gap:** 469 rounds, and the choice distribution is 457 rock / 7 paper /
5 scissors. That is automated harness traffic, not players. There is currently no signal to learn
from, so everything below must be built to work correctly from zero real data.

---

## WHAT TO BUILD

### PART 1 — Skill measurement

Create `player_skill_metrics` (one row per profile, updated on match finalize):

- `predictability_score` — how exploitable this player is. Compute from their own choice
  sequence: first-order frequency bias + conditional bias (what they throw after a win, after a
  loss, after a tie, and after each of their own previous throws). Low = unpredictable = good.
- `read_score` — how well they exploit opponents. Compare their throw against the counter to the
  opponent's *most likely* throw given that opponent's history at that moment. Reward
  choosing the correct counter more often than chance.
- `matches_played`, `rounds_played`, `win_rate`, `last_calculated_at`

Both scores need a confidence/sample-size field. Do not show a skill rating to a player with
under ~30 rounds; return "calibrating" instead. Guard every statistical function against
divide-by-zero and tiny samples — this system starts with almost no data.

### PART 2 — Rating

Implement Glicko-2 (preferred over plain Elo — it carries a rating deviation, which handles the
cold-start and the intermittent-player case correctly).

- `player_ratings` — rating (start 1500), rating_deviation (start 350), volatility, last_played_at
- `rating_history` — append-only, one row per rated match, so you can chart progression and audit
- Rate on **match** result (bo5 outcome), not individual rounds
- Do NOT rate matches where either side `is_harness = true` or `is_owner = true` — those pollute
  the ladder. Filter them everywhere ratings are computed or displayed.

### PART 3 — Seasons and leaderboard

- `seasons` — name, starts_at, ends_at, status (upcoming/active/closed)
- `leaderboard` — a view over `player_ratings` scoped to the active season, excluding harness and
  owner accounts, and excluding anyone below the minimum-rounds threshold
- Return rank, display_name, rating, matches_played, win_rate

### PART 4 — Tournaments (chips only)

- `tournaments` — name, format, entry_fee_chips, prize_pool_chips, max_players, status
  (upcoming/registering/running/complete), starts_at
- `tournament_entries` — tournament_id, user_id, seed, final_position, prize_chips
- `tournament_matches` — links a bracket slot to a real `matches` row
- Single-elimination bracket generation seeded by current rating
- Payouts flow through the **existing** `ledger` with a new reason `tournament_prize`. Do not
  write balances directly — go through whatever RPC currently guarantees conservation.

**Conservation is non-negotiable.** There is already an `integrity_events` row documenting a
settlement anomaly where money rows were destroyed after settlement (table `0dca3e39`), repaired
by migration `20260813120000`. Every chip movement you add must preserve: minted = players +
house. Add an integrity check that asserts this after every tournament settles and writes an
`integrity_events` row if it ever fails.

### PART 5 — Anti-abuse

The ladder is the product. If it can be farmed it is worthless.

- Detect and flag collusion: two accounts playing each other far more than the population norm,
  with a lopsided or alternating result pattern
- Detect self-play: same wallet funding both sides, shared IP, matches finalising suspiciously fast
- Extend the existing `integrity_events` — new kinds: `collusion_suspected`, `rating_farming`,
  `self_play_suspected`. Do not build a parallel system.
- Feed confirmed flags into the existing `profiles.trust_score` and `profiles.flags`

---

## BUILD ORDER

1. Migrations for all new tables + indexes
2. Skill metric functions, with unit tests against hand-built fixture sequences where you know
   the right answer (a pure-rock player must score maximally predictable)
3. Glicko-2 implementation + tests (verify against published worked examples)
4. Backfill from the 75 existing matches — expect near-garbage output because of the harness
   traffic; the point is to prove the pipeline runs end to end, not to trust the numbers
5. Season + leaderboard views
6. Tournament tables, bracket generation, settlement, conservation assertion
7. Anti-abuse detectors
8. Wire into match finalization so ratings update automatically

---

## PROOF REQUIRED

Checkmarks are not a report. For each part, provide:
- the actual migration SQL applied
- test output showing the statistical functions produce correct values on known fixtures
- a query result showing the leaderboard rendering with harness/owner correctly excluded
- a query result proving chip conservation holds after a simulated tournament settles
- git diff or commit sha

If something cannot be done, say exactly what and why. Do not report success on anything you
have not actually verified with output.
