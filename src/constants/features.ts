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
