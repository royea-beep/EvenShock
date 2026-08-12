# Stake tables: off, and exactly what turning them on touches

Spending chips on a cosmetic is a **purchase**. Staking chips against another
player on a chance outcome is a **wager**. The first ships. The second waits for
a lawyer — with or without a rake, because the stake is the risk and the house's
cut is a detail on top of it.

Nothing is deleted. Escrow, settlement, rake, conservation checks, the timeout
table and the phase-3 proofs all remain exactly as built and proven. This
document is the switch.

## The four gates, and which ones matter

| # | Gate | Where | Holds against |
|---|---|---|---|
| 1 | `feature_flags.stake_tables = false` | `mp_create_table`, first statement | **service role** — i.e. our own code |
| 2 | Every `mp_stake_options` row with `stake_chips > 0` is `active = false` | `mp_create_table`'s option lookup | service role |
| 3 | `mp_tables_no_stake_while_disabled` trigger | `before insert on mp_tables` | service role, and any future code path |
| 4 | `STAKE_TABLES_ENABLED = false` | client build flag | a browser |

Gates 1–3 are the real ones. They hold against the **service role**, which is
strictly more powerful than anything a browser or an authenticated API caller
can reach — the `mp_*` RPCs carry zero EXECUTE grants for `anon` or
`authenticated`, and `mp_tables` carries `SELECT` only under RLS. Gate 4 exists
so the UI does not offer something the server would refuse.

Gate 3 is the one that survives a refactor. Gates 1 and 2 live inside a function
someone could rewrite; the trigger fires on the table itself.

## Verified, against production

```
stake 10 via RPC   : error=stakes_unavailable
stake 100 via RPC  : error=stakes_unavailable
free table         : ok=true stake=0          <- unchanged, this is the product
active stakes > 0  : 0
direct insert      : REFUSED (stake tables are disabled (feature_flags.stake_tables))
```

The direct insert bypassed gates 1 and 2 entirely — as the service role, past
RLS, past the function — and gate 3 still refused it.

In the built bundle: the stake picker JSX, the rake notice component and the
`mp_stake_options` query are absent (tree-shaken), and `createTable` compiles to
the literal `{action:'mp_create',format:t,stake:0}`.

## To turn it on

Four changes, in this order. Each is reviewable on its own.

1. **Legal clearance**, in writing, for wagering chips on a chance outcome in
   the jurisdictions we serve. Everything below is mechanical; this is not.
2. **`update public.feature_flags set enabled = true, changed_at = now() where key = 'stake_tables';`**
   — one row, with the reason column updated to name the clearance.
3. **`update public.mp_stake_options set active = true where stake_chips > 0;`**
   — the sizes were preserved, not deleted. The whole-rake CHECK still guards
   any size added later.
4. **`VITE_ENABLE_STAKE_TABLES=true` in `.env`, then merge to `main`** so CI
   rebuilds and deploys. The picker returns; nothing else in the client changes.

Optionally: map `stakes_unavailable` in the `mp` Edge Function's `ERROR_STATUS`
to 503 and redeploy. Today the code travels with HTTP 400 because it is not in
that map — an unambiguous refusal with an imprecise status.

## To turn it off again

Reverse steps 2–4. Turning it off does **not** unwind tables already in flight:
existing staked tables settle or void normally through `mp_sweep`, which is the
correct behaviour — chips already escrowed must come back out, and refusing to
settle them would strand real balances.

## What this does not touch

- **Mainnet.** Separate flag, still off, still fails closed to devnet. Real
  money for chip purchases is a different clearance from wagering them.
- **Free multiplayer.** Invite codes, commit-reveal, the timeout table and
  settlement-by-void all run unchanged; they simply move no chips.
- **Cosmetic spend.** `spend_chips` is untouched and is the only reachable sink
  for a purchased chip while stakes are off.
