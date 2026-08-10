import { defineConfig } from 'vitest/config'

/**
 * The live suites, which `npm test` deliberately cannot see.
 *
 * A separate config rather than a CLI flag because vitest's `--exclude` only
 * ADDS to the exclude list — there is no way to un-exclude from the command
 * line. Which is the behaviour you want here: reaching the live project
 * requires naming this file, and naming it is a decision.
 *
 * No react or tailwind plugin: the round suite imports plain TypeScript modules
 * and never renders anything, so the app's build pipeline is dead weight.
 */
export default defineConfig({
  test: {
    include: ['scripts/harness/**/*.live.test.ts'],
    // These hit a real network and a real database. The default 5s would fail
    // them on latency rather than on truth.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One at a time: the suites share fixed harness users and reset them on
    // entry, so running two in parallel would have each clearing the other's
    // rows out from under it.
    fileParallelism: false,
  },
})
