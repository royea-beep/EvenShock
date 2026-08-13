# Treasury custody

Nothing here creates a key, holds a key, or enables mainnet. It is the shape a
real treasury takes, written before it holds a cent, so the custody decision is
made deliberately rather than by whatever was convenient on the day.

## The finding that decides most of it

**This system is receive-only, structurally.** There is no keypair, no
`secretKey`, no signing primitive anywhere in `supabase/functions/` or in the
client's payment code. The only signer in the entire purchase flow is the
*player's* browser wallet. The treasury address appears in exactly two roles:

1. a value frozen into a `payment_intents` row when an intent is issued
2. a value compared against `postTokenBalances` when a transaction is read

The server observes deposits. It cannot originate a transfer, and there is no
code to delete to keep it that way.

**So the application never needs the treasury key.** Custody is therefore an
operations question, not an architecture one — and the most important property
to protect is that it stays that way. Any future feature that would require the
server to *send* funds (a refund path, a payout, an off-ramp) changes this
document completely and should be treated as a new security review, not an
increment.

## The invariant

> No code path may spend from the treasury. The treasury address may appear only
> in an intent, in a balance comparison, or in a display string.

Worth enforcing the way `runtimeAssumptions.test.ts` enforces the storage rule:
fail the build if a signing primitive appears in the same module as the treasury
address. Not built yet; noted in the checklist as open.

## Options, with the tradeoffs stated honestly

| Option | What it is | Good | Bad |
|---|---|---|---|
| **Hot key in a Supabase secret** | Private key in env, reachable by a function | Trivial to set up; enables automated outflows | Anything that reads env can drain it — a compromised dependency, a leaked service key, a misconfigured function. **Wrong for real money at any scale**, and we do not need the capability it buys |
| **Hardware wallet** (Ledger/Trezor) | Key in a device; signs only when a human plugs it in | Cheap; strong against remote compromise; matches receive-only exactly | One device, one human: loss, theft, bus factor. The seed backup becomes the real attack surface, and it is usually a piece of paper in someone's drawer |
| **Multisig** (e.g. Squads on Solana) | m-of-n approvals enforced on chain | No single person can move funds; survives losing one key; every approval is auditable on chain | Setup complexity; every signer needs their own key hygiene; **recovery must be rehearsed before it is needed**, not discovered during an incident |
| **Qualified custodian** | A regulated third party holds it | Insurance; compliance posture; someone else's audited controls | Cost; counterparty risk; KYC on the entity; slowest path to moving funds |

## The recommendation, and when it changes

**Hardware wallet for a solo operator. Multisig the moment either (a) more than
one person is involved, or (b) the balance stops being trivial.**

"Trivial" is worth defining rather than left to feel: a balance you would shrug
at losing. Once the treasury holds more than a few days of revenue, the cost of
multisig setup is smaller than the expected loss from single-key failure, and
the calculation stops being close.

The hot-key option is listed for completeness and should not be chosen. It buys
automated outflows, which this system does not have and should not acquire
casually.

## Rotation is already config

`payment_config` holds one active row per cluster. `create_payment_intent` reads
the treasury address from it; verification uses the **intent's frozen copy**.
Rotating is:

```sql
update public.payment_config set active = false where cluster = 'mainnet-beta';
insert into public.payment_config (cluster, treasury_address, usdc_mint, usdc_decimals, chips_per_usdc)
values ('mainnet-beta', '<new address>', '<mint>', 6, 100);
```

No deploy, no cutover window, and intents quoted under the old address still
verify against the address they were quoted with. That property already exists
and the mainnet design must not break it.

## What this does not cover

- **Where the seed backup lives.** That is the real risk in the hardware option
  and it is a physical-security question, not a code one.
- **Who may approve a multisig transaction**, and what happens when one signer
  is unavailable. Rehearse it before it matters.
- **Any outbound payment.** There is no off-ramp, no withdrawal, no refund in
  money. If one is ever proposed, this document is void and the whole custody
  question reopens.
