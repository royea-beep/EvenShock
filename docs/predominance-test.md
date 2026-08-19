# Predominance test — EvenShock

**Status: NOT ESTABLISHED. There is no defensible head-to-head figure today,
because there are no head-to-head matches.** This document records what was
measured, what it does and does not support, and exactly what would have to be
collected to answer the question properly. Run 2026-08-14 against production
(`qgnxppzchqwpwerajhlu`).

The standard being tested is the one Skillz publishes: a skilled player must
beat an unskilled player in **at least 75% of matches**, with a materiality
test on how much systemic chance remains. The unit is the **match**, because
that is how tournaments settle.

---

## 1. Defining skilled and unskilled

**Skill axis = `predictability_score` (inverted).** Lower is more skilled.

No new axis was invented for this test, deliberately — a bespoke metric built
for a legal argument is the first thing an opponent attacks. `predictability_score`
was built to drive Nemesis, is computed by `skill_predictability()`, and is
already the quantity the opponent AI exploits.

It is the right axis on the merits too. In rock-paper-scissors there is exactly
one way to lose to a better player: be readable. The metric is the
**exploit-value** of a player's history — for each context (marginal, previous
throw, previous outcome, and the joint of the last two), it computes
`V(X) = p(X) + 0.5·p(beats(X))` and takes the best-performing lens, Jeffreys-
smoothed (α = 0.5) so a three-observation context cannot look like a certainty.
0 means nothing in the player's history predicts their next throw; 1 means a
perfect read.

`read_score` — how often a player counters what their opponent's history
predicted — is the natural complement and is the better axis for the *offensive*
half of skill. **It is unusable today: it reads 0.000 for every account on file**,
because it can only be computed from play against another human and no such play
exists (see §2).

---

## 2. Head-to-head win rate — cannot be computed

```
population                            n
------------------------------------  ---
solo matches (vs bot/nemesis)         138
  of which opponent = nemesis          63
mp tables (human vs human), settled      0
mp tables, any status                    1
distinct players in mp tables            2
profiles total                          19
profiles NOT harness/owner               1   <- and that one is the treasury
players with a predictability score      4   <- 3 harness + 1 treasury
players above the confidence floor       3   <- all harness
rateable players on the ladder           0
```

**The measurable population is zero.** One multiplayer table has ever reached
`finished`, none has settled, and both seats on it were operational accounts.
The single profile that is neither harness nor owner is the treasury wallet,
which `is_rateable_player` deliberately excludes and which is `calibrating`
anyway at 21 rounds.

There is therefore **no per-format head-to-head number**, and any figure
presented as one would be fabricated. This is the answer to question 2 and it
does not have a confidence interval, because it has no observations.

The skill spread that does exist is also unusable — three harness accounts at
predictability 0.996, 0.981 and 0.652, one of which throws rock 100% of the
time. That is not an unskilled *player*; it is a script. A win rate against it
measures the script.

---

## 3. What the format arithmetic requires — exact, and data-independent

This part owes nothing to our data. Ties are replayed rather than scored, so
every round eventually resolves; a first-to-*k* match is won by whoever takes
*k* decisive rounds first. With `q` = the skilled player's chance of taking any
one decisive round:

```
P(match) = Σ(j=0..k-1) C(k-1+j, j) · q^k · (1-q)^j
```

Inverting it for the 75% standard:

| format | first to | q required to clear 75% |
|---|---|---|
| single | 1 | **0.7500** |
| bo3 | 2 | 0.6736 |
| bo5 | 3 | 0.6406 |
| bo7 | 4 | 0.6212 |
| bo9 | 5 | 0.6080 |
| bo11 | 6 | **0.5984** |
| bo15 | 8 | 0.5850 |
| bo21 | 11 | 0.5723 |

**This confirms the expectation about single rounds and refines the one about
bo5.** A single round cannot compound anything — the match *is* the round, so
it demands the full 75% per round, which in RPS means reading your opponent
three times in four. Longer formats lower the bar monotonically, but with sharp
diminishing returns: bo3→bo5 buys 3.3 points of required edge, bo5→bo11 buys
only 4.2 more, and bo11→bo21 buys 2.6. **Past roughly bo11 the format stops
being the lever.** If a real measured `q` lands below ~0.60, no format that a
player will sit through will rescue it.

---

## 4. The only edge this system has actually measured

Not a predominance result. The closest available proxy: rounds where Nemesis
played its read versus rounds it threw blind, from 345 production
`nemesis_rounds`. Outcomes stored from the player's perspective, inverted here
to the reader's.

```
branch                    rounds  reader_wins  reader_losses  ties  decisive  q
------------------------  ------  -----------  -------------  ----  --------  ------
reader threw blind           248           78             91    79       169  0.4615
reader played its read        97           77             11     9        88  0.8750
pooled                       345          155            102    88       257  0.6031
```

| quantity | q | 95% CI (Wilson) |
|---|---|---|
| blind rounds | 0.4615 | 0.3881 – 0.5367 |
| successful read | **0.8750** | 0.7899 – 0.9287 |
| pooled | 0.6031 | 0.5422 – 0.6610 |

Propagated through the match formula:

| format | at q = 0.6031 (pooled) | at q = 0.8750 (read branch) |
|---|---|---|
| single | 60.3% (54.2 – 66.1) | 87.5% (79.0 – 92.9) |
| bo3 | 65.2% (56.3 – 73.3) | 95.7% (88.6 – 98.5) |
| bo5 | 68.8% (57.9 – 78.2) | 98.4% (93.4 – 99.7) |
| bo7 | 71.6% (59.2 – 81.8) | 99.4% (96.1 – 99.9) |
| bo9 | 74.0% (60.3 – 84.6) | 99.8% (97.6 – 100) |
| bo11 | 76.0% (61.3 – 86.9) | 99.9% (98.5 – 100) |

**Neither column is a predominance result, and the reasons are disqualifying:**

- **The opponents were scripts, not unskilled humans.** The three accounts have
  predictability 0.65–0.996; one throws rock every single time. Against a human
  the read rate collapses, and `q` with it.
- **Nemesis is not a player.** It has perfect recall of the opponent's lifetime
  history and a decayed four-model predictor. A human opponent has memory and
  intuition. The 0.875 read branch is what *software* achieves against a *script*
  and is an upper bound no human reaches.
- **The pooled 0.6031 embeds a product setting**, not a skill ceiling: Nemesis
  exploits on only 35% of rounds by configuration (`nemesis_config.exploit_rate`).
- Even taken at face value, the pooled column clears 75% only at bo11 and only
  on the point estimate — the CI lower bound (61.3%) is nowhere near.

---

## 5. Materiality — how much systemic chance remains

This is the one place the answer is structural and strong.

**In head-to-head play, systemic chance is zero.** There is no shuffle, no deal,
no dice, no random number generator anywhere in a multiplayer round. Both moves
come from two humans; the server only holds and reveals them under commit-reveal.
Whatever randomness exists is *strategic* — a player deliberately mixing their
own throws — which is a decision, not a mechanism. That distinction is the
substance of a materiality test.

**In solo play, chance is total, and this is measured, not assumed.** The bot
draws uniformly from `crypto.getRandomValues`. Against a uniform opponent every
strategy has identical expected value — no throw is better than any other. The
blind branch above confirms it empirically:

```
q = 0.4615, 95% CI 0.3881 – 0.5367 — 0.50 is inside the interval
```

**Consequence, and it is the most actionable line in this document: cash
tournaments must be human-vs-human. A prize-bearing mode played against the
random bot is a pure game of chance by construction, and no amount of format
length changes that** — compounding a 50% edge gives 50% at every length. The
existing tournament implementation already routes every bracket slot through an
mp table, so the product is on the right side of this; it must stay there.

Nemesis is the middle case and does not fix it. It is adaptive, so play against
it is not pure chance — but the opponent is still software the house controls,
which is a different legal posture from player-versus-player and should not be
leaned on.

---

## 6. Statistical power — what it would take

To estimate a match win rate around 0.75:

| goal | matches needed |
|---|---|
| ±10pp confidence interval | 73 |
| ±5pp | 289 |
| ±3pp | 801 |
| **prove >75% when the truth is 80%** | **246** |
| prove >75% when the truth is 85% | 49 |
| prove >75% when the truth is 90% | 16 |

**Target ≈ 250–300 completed head-to-head matches**, and the composition matters
more than the count:

1. **Real humans on both sides.** No harness accounts — they are `is_harness`
   flagged at creation precisely so they can be excluded here.
2. **A measured skill gap, set before the match, not after.** Both players need
   a `predictability_score` above the confidence floor (≥30 rounds) *prior* to
   being paired, and pairing should be top-tercile against bottom-tercile.
   Classifying players using the same matches you are scoring is circular and is
   the flaw a reviewer will look for first.
3. **Enough distinct players that the result is not two people.** 250 matches
   between 4 accounts measures those 4 people. Thirty-plus distinct players on
   each side is the minimum for the number to describe the game.
4. **Per format.** 250 matches *per format* if a per-format claim is wanted;
   otherwise pick the format the product will actually run and measure that one.

At current volume — 138 solo matches and one unsettled mp table — this is
several months of real usage away, not a rerun of a script.

---

## 7. What can honestly be said today

- The game contains a **real, measured skill mechanism**: reading an opponent
  and playing the counter converts a decisive round at **0.875 (95% CI 0.790 –
  0.929)** versus **0.462 (0.388 – 0.537)** when throwing blind. The mechanism
  exists and is large.
- **Whether it predominates over chance in match play is unmeasured.** The
  apparatus is built and the query is one command; the players are missing.
- **Solo play against the random bot is chance, measured and confirmed**, and
  must never carry a prize.
- Nothing here should be represented as a passed predominance test.

