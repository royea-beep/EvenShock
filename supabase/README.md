# Database

The schema for the EvenShock Supabase project, as migrations. Everything the
database does — tables, RLS policies, column grants, the provisioning trigger,
the leaderboard — is defined here and nowhere else. Applying `migrations/` in
filename order to an empty project reproduces it exactly.

Project ref: `qgnxppzchqwpwerajhlu`.

## Applying

```bash
supabase link --project-ref qgnxppzchqwpwerajhlu   # writes config.toml
supabase db push
```

`config.toml` is not committed — `supabase link` generates it, and it is per
developer.

## The two rules worth knowing before editing

**The wallet address is never client-writable.** A connected wallet only
asserts an address; the assertion is worth nothing until Supabase Auth has
verified a signature. `handle_new_web3_identity()` copies the address out of
`auth.identities` after that has happened. Nothing else writes
`profiles.wallet_address`, and `authenticated` holds no UPDATE grant on the
column. Adding one would let any player claim any wallet.

**Row access and column access are separate gates.** Policies decide which rows
a caller sees; column grants decide which columns they can write. Both are set
up so that a mistake in either one alone is not enough to cause a breach —
`profiles_update_own` says "this row is yours", and the grant list says
"...but not `wallet_address`, `verified_at`, `trust_score` or `flags`". Keep
them independent. A new column on `profiles` is unwritable by default, which is
the right default; add it to the `grant update (...)` list only if players are
meant to set it themselves.

`matches` and `rounds` are append-only for clients: no UPDATE, no DELETE grant,
and `user_id`/`created_at` take server-side defaults rather than being
insertable, so history cannot be forged, backdated, or quietly edited.

## Verifying a change

The policies are worth testing rather than eyeballing, and it is cheap: create
two users, act as each in turn, and assert the negatives. A rolled-back
transaction that sets `role authenticated` plus a `request.jwt.claims` sub, and
checks that user B cannot read A's rows, cannot write protected columns, and
cannot attach rows to A's match, catches the mistakes that reading the policy
text does not.

After any change, check the linter — `get_advisors(type: "security")` via the
MCP server, or the Advisors tab in the dashboard. Two `SECURITY DEFINER`
warnings are expected and intentional: `ensure_profile()` and `leaderboard()`
are both granted to `authenticated` on purpose, and both are narrow. Anything
else is worth reading closely.
