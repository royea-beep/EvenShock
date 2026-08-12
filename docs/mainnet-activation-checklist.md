# Mainnet activation checklist

The moment `SOLANA_CLUSTER=mainnet-beta` is set on the edge function, real
money is on the line. Every item here MUST be done before that flip, and every
item is a step where an oversight becomes an incident that a lawyer, a
customer or a bank will read about.

The list is short on purpose. Long checklists get skimmed; short ones get done.

---

## Chain / edge function

- [ ] `SOLANA_CLUSTER` on the play edge function is `mainnet-beta` (currently `devnet`)
- [ ] `SOLANA_RPC_URL` points to a mainnet-beta RPC — Helius or QuickNode, NOT
      `api.mainnet-beta.solana.com` (that URL rate-limits under real load and
      will cause `confirm_payment` to time out on legitimate purchases)
- [ ] `SOLANA_TREASURY` is a hardware-wallet or multisig address the app has
      never held the key for. See `docs/treasury-custody.md`
- [ ] `SOLANA_USDC_MINT` is `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
      (canonical mainnet USDC, not the devnet mint)
- [ ] `public.payment_config` has an `active=true` row for `cluster='mainnet-beta'`
      pointing at the SAME treasury + mint as the env vars above. The env is
      cross-checked against the row on every `loadIntent`; a mismatch here
      means every purchase refuses.
- [ ] The Supabase CSP allow-list in `public/.htaccess` includes the mainnet
      RPC host (not just `api.devnet.solana.com`)

## Database backups (this project, this plan)

- [ ] **PITR add-on enabled at the 7-day tier (~$100/mo).** Non-negotiable.
      Daily backups lose up to 24 hours of ledger; PITR loses seconds.
- [ ] Confirmed in the Supabase dashboard: `Settings → Database → Backups`
      shows a **Recovery point** timestamp within the last few minutes
- [ ] `supabase backups list --project-ref qgnxppzchqwpwerajhlu` shows a
      backup from the last 24 hours
- [ ] **Restore drill run within the last 30 days**: see the drill section
      below. A hope is not a backup.

## Geo / jurisdiction

- [ ] `geo_blocklist` reviewed with counsel for the current mainnet launch set
- [ ] `geo_allows_money` is verified to refuse the exact list counsel signed
      off on. A `geo_refusals` count of `0 in 24h` on the `owner_money_digest`
      after go-live means the gate is not actually running — investigate.
- [ ] Datacenter IP handling — `is_datacenter` flag from ipwho.is treated as
      `geo_unknown`, not as the caller's real country. Confirms in the digest
      as `geo_refused → reason: 'geo_unknown'` counts, not spurious allows.

## Monitoring

- [ ] `npm run monitor:digest -- --alert` returns exit 0 immediately before
      the flip (no red conditions)
- [ ] A person is watching the digest daily for the first week post-launch
- [ ] If automated alerts are wired (Discord/ntfy/email), they are tested by
      deliberately tripping one red condition (e.g. `insert into ledger` with
      a delta that makes conservation drift by 1, verify alert fires, revert)

## Load and abuse

- [ ] `npm run e2e:load` is 8/8 green against production within the last week
- [ ] `npm run devnet:e2e` is 18/18 green — chain path still works after any
      mainnet-related code change

---

## The restore drill

Runs against a scratch project restored from a real Supabase backup — the
only way to prove the backup file is not corrupt.

### One-time setup (per drill; scratch project is temporary)

1. Open https://supabase.com/dashboard/project/qgnxppzchqwpwerajhlu/database/backups
2. Choose the most recent backup that includes the ledger row you want to
   confirm (the top row is fine)
3. Click **"Restore to a new project"** — this is the Studio flow that the
   CLI does NOT expose
4. Name the new project `evenshock-restore-drill`, region `eu-central-1`, Pro plan
5. Wait ~5 minutes for provisioning + restore
6. Copy the scratch project's URL and service_role key from
   `Settings → API`

### Run the drill

```bash
export SUPABASE_SCRATCH_URL="https://<scratch_ref>.supabase.co"
export SUPABASE_SCRATCH_SERVICE_ROLE_KEY="<scratch_service_role>"
npm run monitor:restore-drill -- --scratch=<scratch_ref>
```

Compares every money-relevant total (balances sum, ledger sum, payment PK,
house_ledger, row counts across the tables that matter) between production
and the restored copy. Any drift is a failure that gets printed.

### After the drill

7. Pause or delete `evenshock-restore-drill` (Settings → Pause project)
   — a paused project on Pro is free
8. Log the drill run date, backup timestamp, and PASS/FAIL somewhere durable
   (the mainnet activation ticket, an ops note, wherever future-you will look)

---

## The flip

Only after every box above is checked:

1. `supabase secrets set --project-ref qgnxppzchqwpwerajhlu SOLANA_CLUSTER=mainnet-beta`
2. `supabase secrets set --project-ref qgnxppzchqwpwerajhlu SOLANA_RPC_URL=<mainnet-rpc>`
3. `supabase secrets set --project-ref qgnxppzchqwpwerajhlu SOLANA_TREASURY=<mainnet-treasury>`
4. `supabase secrets set --project-ref qgnxppzchqwpwerajhlu SOLANA_USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
5. `supabase functions deploy play --project-ref qgnxppzchqwpwerajhlu`
6. Verify — `npm run monitor:digest` — conservation ok, house ok, double_credit ok
7. Manual first purchase from an owner wallet: 1 USDC → 100 chips credited within a minute

The mainnet CSP fix is committed here so the deploy can go directly. The
above sequence is one console session, not a project.

## Rollback

If any of steps 5-7 fail:

```bash
supabase secrets set --project-ref qgnxppzchqwpwerajhlu SOLANA_CLUSTER=devnet
supabase secrets set --project-ref qgnxppzchqwpwerajhlu SOLANA_RPC_URL=<devnet-rpc>
# treasury/mint unchanged — the edge function refuses to serve payments on
# a cluster whose treasury/mint mismatch, so devnet + mainnet treasury is a
# safe transitional state (all purchases refuse until the config is coherent)
supabase functions deploy play --project-ref qgnxppzchqwpwerajhlu
```

Any purchase in flight at the moment of rollback: the money is on-chain and
irreversible. Reconciliation will credit it when the config is coherent again.
The intent's `reference` makes this findable without the player's help.
