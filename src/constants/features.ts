/**
 * Build-time feature flags. Off unless explicitly switched on.
 *
 * Read from `import.meta.env` so Vite inlines them at build time: a disabled
 * feature is a `false` constant, its branches are dead code, and re-enabling
 * one is a deliberate act with a rebuild attached rather than something a
 * runtime value could flip.
 */

/**
 * FAST MODE IS FROZEN.
 *
 * Three consistent measurements put its p95 over the 501ms reveal budget on
 * desktop — and desktop is the best case. Until it has been measured on a
 * phone on mobile data, which is the runtime the budget is actually about, a
 * player should not be able to reach it.
 *
 * FROZEN, NOT DELETED. The pacing code in constants/gameConfig.ts, the
 * `useFastMode` hook, the toggle component and the stall indicator all stay
 * exactly as they are, because the measurement that unfreezes this needs
 * something to measure. Regular mode (870ms) is untouched.
 *
 * The gate is inside `useFastMode` rather than only around the toggle, and
 * that placement matters: fast mode can also arrive from a localStorage key
 * set before the freeze, or from `profiles.fast_mode` via the prefs migration.
 * Hiding the toggle alone would leave those players stuck in fast mode with
 * no control to turn it off.
 *
 * To re-enable: VITE_ENABLE_FAST_MODE=true, and rebuild.
 */
export const FAST_MODE_ENABLED = import.meta.env.VITE_ENABLE_FAST_MODE === 'true';

/**
 * MULTIPLAYER EXISTS SERVER-SIDE AND NOT YET IN THIS APP.
 *
 * The tables, escrow, rake and commit-reveal protocol are deployed and tested;
 * no screen in `src/` calls any of it. The entry screen advertises playing a
 * friend because that is what connecting a wallet is FOR, and hiding the reason
 * would defeat the point of the screen — so the bullets carry a "soon" tag
 * while this is false, and flipping it to true removes the tag everywhere at
 * once.
 *
 * This is the honest middle between promising a button that does not exist and
 * pretending the feature is not coming. It flips in the same change that ships
 * the multiplayer UI, never before.
 */
export const MULTIPLAYER_UI_ENABLED = import.meta.env.VITE_ENABLE_MULTIPLAYER === 'true';

/**
 * STAKE TABLES ARE OFF, AND THE REASON IS NOT TECHNICAL.
 *
 * Spending chips on a cosmetic is a purchase. Staking chips against another
 * player on a chance outcome is a wager. The first is unambiguous and ships;
 * the second is the thing a lawyer has to clear, and it waits — with or
 * without a rake, because the stake is the risk, not the house's cut.
 *
 * OFF MEANS ABSENT, not hidden. With this false, `loadStakeOptions` returns
 * the free table only, no stake picker renders, and `createTable` cannot send
 * a nonzero stake — the value is dropped at the boundary rather than trusted
 * from a caller. Vite inlines the constant, so the picker is not in the bundle
 * to find with dev tools.
 *
 * IT IS NOT THE ONLY GATE, and deliberately not the important one. The server
 * refuses independently: `feature_flags.stake_tables` is false, every priced
 * option in `mp_stake_options` is deactivated, and a trigger on `mp_tables`
 * rejects a staked insert outright. All three hold against the service role,
 * which is stronger than anything a browser can reach. This flag exists so the
 * UI does not offer something the server would refuse.
 *
 * Nothing is deleted. Escrow, rake, settlement and the conservation proofs all
 * stay exactly as built. To turn it on: VITE_ENABLE_STAKE_TABLES=true, rebuild,
 * and `update feature_flags set enabled = true where key = 'stake_tables'`
 * plus reactivating the priced rows in mp_stake_options. See
 * docs/stake-tables-flag.md.
 */
export const STAKE_TABLES_ENABLED = import.meta.env.VITE_ENABLE_STAKE_TABLES === 'true';

/**
 * TOURNAMENTS RIDE ON THE FRIEND MATCH.
 *
 * A bracket slot is played as an ordinary mp table, so this flag is meaningful
 * only when MULTIPLAYER_UI_ENABLED is also true — the panel is gated on both,
 * and the "and" is deliberate rather than defensive. Shipping a bracket whose
 * Play button cannot open a table would be a lobby that takes an entry fee for
 * a match nobody can start, which is worse than no tournaments at all.
 *
 * The entry fee is NOT a stake and this flag is not a way around
 * STAKE_TABLES_ENABLED. A stake is chips risked on the outcome of one match
 * against one opponent; an entry fee buys a seat in a draw whose whole pool is
 * paid back out to the top two. Every table a tournament creates is stake
 * zero, hard-coded server-side in tournament_open_match — so the wagering flag
 * stays off, and nothing here approaches the trigger that rejects staked
 * inserts.
 */
export const TOURNAMENTS_UI_ENABLED = import.meta.env.VITE_ENABLE_TOURNAMENTS === 'true';

/**
 * NEMESIS — the adaptive solo opponent.
 *
 * Off until the `play` Edge Function carrying the predictor is deployed. That
 * ordering is the whole reason this flag exists: `open_match` accepts an
 * `opponent` argument with a DEFAULT of 'random', so an app that offers the
 * choice while the old function is live would take the pick, send it nowhere,
 * and hand the player a uniform bot labelled Nemesis. Every number in the
 * debrief would then be true about a match the player thinks they had with
 * something else.
 *
 * The gate is the prop being undefined in App, not a hidden button — same
 * pattern as tournaments and the friend match. With it off, HomeScreen renders
 * exactly the screen it rendered before Nemesis existed.
 *
 * To enable: VITE_ENABLE_NEMESIS=true, and rebuild — after the deploy.
 */
export const NEMESIS_UI_ENABLED = import.meta.env.VITE_ENABLE_NEMESIS === 'true';
