# What a licensed operator would need that we do not have

The scope you would discover in due diligence, listed before the conversation
rather than during it. Nothing here is a promise of a date; it is an honest
inventory so the licensing discussion starts from the real surface.

Ordered by how likely each is to stop a deal.

---

## Blocking for most licensed operators

**Responsible gaming — entirely absent.** There is no deposit limit, no session
limit, no loss limit, no reality check, no cool-off. A licence that requires
player-protection tooling is not satisfiable with this product today. This is
the largest single gap and it is not close.

**Self-exclusion — absent.** No register, no enforcement, no way for a player to
exclude themselves, and no way to honour a national exclusion list. Related and
equally missing: the ability to *refuse* a player at all, since there is no
account-suspension mechanism beyond deleting data.

**Age verification — absent.** The purchase copy states 18+; nothing checks it.
There is no date-of-birth capture and no integration with a verification
provider.

**KYC / AML — absent.** Players are identified by wallet signature or an
anonymous session. There is no identity capture, no sanctions screening, no
source-of-funds checking, no transaction monitoring beyond the abuse detectors,
and no suspicious-activity reporting workflow.

**RNG certification — not held.** The bot draws from `crypto.getRandomValues`
with rejection sampling to avoid modulo bias, and the commit-reveal protocol
means a player can verify the server did not change its move. **That is a
fairness proof, not a certification.** Test houses (GLI, eCOGRA, iTech Labs and
similar) certify the generator and the game maths against a published standard,
and no such certificate exists. Budget for it as a real line item with a
schedule, not a formality. Note also that the solo bot's randomness is the one
place systemic chance genuinely lives — see the predominance document.

**Player fund segregation — not applicable as built, and that needs saying
carefully.** We never hold player funds: USDC moves from the player's wallet to
the operator's treasury directly. There is nothing to segregate on our side.
Whether *your* treasury must be segregated from operating capital is a question
about you, and this software neither helps nor hinders it.

## Significant, but usually negotiable

**Terms of service, privacy policy, complaints procedure.** Placeholder copy
only. A ToS acceptance mechanism exists and is enforced before purchase — the
text it accepts is yours to write.

**Dispute resolution.** Every match is fully reconstructable from the round
records and the ledger, so a dispute can be *answered*. There is no tooling for
it: no support console, no per-player transaction view, no way for staff to
inspect a match without SQL.

**Data protection.** Player data lives in the operator's own database, which is
the right shape. There is no retention policy, no automated erasure workflow, no
data-export endpoint. Account deletion exists but has not been reviewed against
GDPR erasure requirements.

**Reporting.** No regulatory reporting, no standard financial exports, no
scheduled statements. The owner digest is an operational tool, not a report.

**Advertising and bonus rules.** The daily streak bonus is a promotion. Many
licences regulate promotions specifically — wagering requirements, disclosure,
opt-out. None of that framework exists.

## Technical gaps that become compliance gaps at scale

**Rate limits are code, not configuration.** Changing them needs a migration.
Everything else operator-facing is data.

**Themes are code.** Visual rebranding is bespoke work, not a setting. Name,
share origin and support contact are configuration; the look is not.

**No availability guarantees.** No SLA, no formal incident process, no
status page. A restore drill exists and has been run; it is not a commitment.

**Mainnet has never been exercised.** Everything measured, tested and proven in
this repository was done on devnet. The mainnet path is gated deliberately and
has a written activation checklist, but it has not been walked end to end with
real money.

**The predominance test has not been passed.** It has not been *failed* either —
it cannot presently be run, because the deployment has no real players. If your
market treats skill predominance as the basis for operating without a gambling
licence, this is the item to resolve first, and it needs roughly 250–300
head-to-head matches between 30+ distinct players per side. See
`docs/predominance-test.md`.

---

## How to read this list

Most of it is not our software's job. KYC, self-exclusion and age verification
sit in an operator's account layer, in front of or beside a game supplier, and
a licensed operator usually already has them. The items that are genuinely ours
are **RNG certification**, **responsible-gaming hooks the operator can drive**
(we would need to expose limits and exclusion as enforceable states in the game
itself), and **support tooling**.

If a client asks "can you supply us", the honest answer today is: the game,
its fairness properties and its integrity controls are supplier-grade and
documented; the player-protection surface is not built, and we should scope it
against their specific licence rather than guess.
