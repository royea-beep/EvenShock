# Supplier and operator responsibilities

The document a licensed operator is asked to hold about their software
suppliers. It states what the software does, what it deliberately does not do,
and where the line between us falls.

Written to be read by someone who is not an engineer, and to be handed to a
regulator without editing.

---

## What is supplied

Rock-paper-scissors as a skill game: solo play against a bot, head-to-head play
against another person, and single-elimination tournaments. An in-game credit
("chips") with no cash value, no redemption path and no way to leave a player's
account. Optionally, purchase of chips with USDC on Solana, paid directly to the
operator's own treasury.

Supplied as software the operator deploys and runs. There is no shared runtime,
no shared database and no shared control plane.

---

## The line

| | Supplier (us) | Operator (you) |
|---|---|---|
| **Game logic and fairness** | Ours. Commit-reveal protocol, outcome rules, rating and skill metrics, the anti-abuse detectors. | — |
| **Licensing** | None held, none claimed. | Yours entirely. We make no representation that any deployment is lawful anywhere. |
| **Player identity / KYC / AML** | Not implemented. The software identifies players by wallet signature or anonymous session only. | Yours. If your licence requires identity verification, it sits in front of or beside this product; we do not provide it. |
| **Player funds** | Never held. We have no wallet, no custody, no key, no access to your treasury. | Yours. The treasury is your wallet; funds move from player to you directly on chain. |
| **Geographic restriction** | We provide the enforcement mechanism and it ships on. | Yours to configure. The blocklist is a table you populate; which jurisdictions belong in it is a legal determination we do not make. |
| **Responsible gaming** | **Not implemented.** See gaps. | Yours, and today it is not in this product at all. |
| **Age verification** | Not implemented. Copy states 18+ for purchases; nothing enforces it. | Yours. |
| **Terms, privacy, complaints** | Placeholder copy only. | Yours. |
| **Player data** | We hold none. It is in your Supabase project. | Yours, including retention, access requests and breach obligations. |
| **Availability and incident response** | We supply the software. | Yours to run, monitor and restore. |

## Three things worth stating plainly

**We hold no player money at any moment.** A chip purchase is an on-chain
transfer from the player's wallet to the operator's treasury, verified by
reading the chain. The software credits chips only after confirming the transfer
landed. There is no intermediary account and no float.

**Chips cannot become money.** There is no withdrawal, redemption, conversion or
transfer between players anywhere in the software. This is a design property
enforced in the database, not a policy in a document — and it is the single
largest thing keeping this product on the correct side of most gambling
definitions. An operator who adds an off-ramp changes the legal character of the
product entirely, and would be doing so as a decision of their own.

**Wagering ships off.** Chips can be staked on a match outcome; that capability
is built, tested and disabled behind a flag plus three independent database
gates. It is off because wagering is the unresolved question, not because it is
unfinished.

## What an operator must not assume

- That any measurement in our compliance pack was taken on *your* deployment. It
  was taken on ours. Re-run them; the tooling ships with the software.
- That geo-blocking is on. It ships on, and it can be turned off. Check it, and
  check the audit trail that records every change.
- That the software prevents a determined player from evading a geographic
  restriction. IP geolocation is a compliance signal, not a security control.
- That anything here constitutes legal advice. It does not.
