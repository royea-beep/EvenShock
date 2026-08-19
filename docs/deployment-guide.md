# Deploying this game as your own

For an operator licensing the software. It states everything you configure and,
just as importantly, everything you do **not** have to edit — if you find
yourself changing source to launch, that is a defect on our side and we want to
hear about it.

A test enforces this: `src/constants/portability.test.ts` fails the build if an
operator-specific value appears anywhere in source outside `constants/brand.ts`,
or if a setting the code reads is missing from `.env.example`.

---

## 1. Infrastructure you provide

| Thing | Notes |
|---|---|
| A Supabase project | Postgres + Auth + Edge Functions. Region is yours to choose; put it near your players, not near us. |
| A static host | The client is a Vite SPA — any static host or CDN. No server-side rendering, no Node runtime. |
| A domain | Whatever you like. It goes in `VITE_SHARE_ORIGIN`. |
| A Solana treasury wallet | **Only if you enable chip purchases.** Yours, never ours; see §4. |

There is no shared control plane. Your deployment talks to your Supabase
project and nothing else. We have no access to it, and no ability to reach your
players or your ledger.

---

## 2. Client configuration — all environment variables

Copy `.env.example` and fill it in. Nothing here is code.

| Variable | Required | What it does |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | Your project. |
| `VITE_SUPABASE_ANON_KEY` | yes | Your publishable key. |
| `VITE_BRAND_NAME` | yes | Appears in the UI, the share line, and the **wallet sign-in prompt** a player approves in a popup. Leaving it unset shows them our name on your site. |
| `VITE_SHARE_ORIGIN` | yes | Where shared and invited players land. **Invite links are built from this** — unset, your players' invitations point at our deployment. |
| `VITE_SUPPORT_CONTACT` | recommended | Where a player takes a problem. Empty hides the line rather than showing an address that does not answer. |
| `VITE_ENABLE_MULTIPLAYER` | yes to play friends | Required for tournaments, which are played as multiplayer tables. |
| `VITE_ENABLE_TOURNAMENTS` | optional | Requires multiplayer. |
| `VITE_ENABLE_NEMESIS` | optional | The adaptive opponent. Requires the `play` Edge Function that carries the predictor. |
| `VITE_ENABLE_STAKE_TABLES` | **leave off** | Wagering chips on a match. Gated at three independent database checks as well as this flag. See §6. |
| `VITE_ENABLE_FAST_MODE` | leave off | Frozen: measured p95 over its own reveal budget on desktop. |

## 3. Server configuration — data, not deploys

Every one of these is a row you change with SQL. None needs a migration, a
rebuild or a redeploy.

| What | Where | Notes |
|---|---|---|
| Treasury address, USDC mint, chip price | `payment_config` | Per cluster. The Edge Function also pins treasury and mint in its environment and refuses any payment that disagrees — so a database rewrite alone cannot redirect funds. |
| Blocked countries | `geo_blocklist` | Rows, with a reason column. Adding or removing a jurisdiction is an `insert` or an `update`. |
| Geo enforcement master switch | `feature_flags.geo_blocking` | Ships **ON**. Every flip writes an audit row naming who and when. See the compliance pack. |
| Wagering | `feature_flags.stake_tables` | Ships **OFF**. |
| Nemesis difficulty | `nemesis_config` | Exploitation rate, cold-start ramp, recency half-life. Every change is logged. |
| Rate limits | `take_rate_token` | Currently constants in a function body — see the known limitation below. |

**Known limitation, stated rather than discovered:** per-action rate limits live
in the body of `take_rate_token` rather than in a table, so changing them needs
a migration. It is the one server-side setting that is not pure data. Tell us
your numbers and we will move it to a table; nothing about the design resists
it, it simply has not been asked for yet.

## 4. Money, if you enable it

Chip purchases are USDC on Solana, paid to **your** treasury. We never hold
player funds and never touch that wallet — see the supplier boundary document.

Set the Edge Function environment: `SOLANA_RPC_URL`, `SOLANA_CLUSTER`,
`SOLANA_TREASURY`, `SOLANA_USDC_MINT`. Setting three of four collapses the
whole payment config to null and every payment endpoint refuses at the door,
deliberately — a half-configured money path fails closed rather than pointing a
mainnet deployment at a devnet RPC.

Chips do not leave the game. There is no withdrawal, redemption, conversion or
off-ramp anywhere in the software, and adding one is a decision with legal
consequences that belong to you, not a setting.

## 5. Branding beyond the name

The name, share origin and support contact are configuration. **The visual
themes are not** — they are React components and Tailwind tokens in source.
An operator who wants their own look is a code change today, and we would do
that as bespoke work rather than pretending it is a setting.

## 6. What we recommend you do not enable

`stake_tables` puts chips at risk on a match outcome. It is built, tested and
proven, and it is off because wagering is the unresolved legal question in most
jurisdictions. If your licence covers it, turn it on knowingly and with counsel.
Nothing in this software makes that determination for you.
