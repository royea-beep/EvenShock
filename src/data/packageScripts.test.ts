import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * npm scripts have to run on the machine that actually runs them.
 *
 * Every live harness in this repo is invoked from Windows, and
 * `EVENSHOCK_LIVE=1 node …` is POSIX shell grammar. Neither cmd.exe (npm's
 * default shell on Windows) nor PowerShell has an assignment-prefix form —
 * both take the first whitespace-delimited token as the program name and go
 * looking for an executable literally called `EVENSHOCK_LIVE=1`:
 *
 *   'EVENSHOCK_LIVE=1' is not recognized as an internal or external command
 *
 * Which meant every script that needs the live interlock was broken on the
 * only machine that can reach production — the harnesses were unrunnable
 * precisely where they were needed.
 *
 * WHY THE FLAG DID NOT MOVE INTO .env, which was the other option. The env
 * var is an INTERLOCK, not configuration: `EVENSHOCK_LIVE=1` has to be a
 * deliberate act per invocation, because these suites write to production.
 * A value in `.env` is set once and then true forever, which turns a
 * per-run decision into ambient state and leaves the exclude glob as the
 * only thing standing between a stray command and live data. `cross-env`
 * keeps the interlock exactly as designed and only fixes the grammar.
 */

const SCRIPTS: Record<string, string> = JSON.parse(
  readFileSync('package.json', 'utf8'),
).scripts;

/** One or more `NAME=VALUE` assignments before the command: POSIX-only. */
const POSIX_ASSIGNMENT_PREFIX = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

describe('npm scripts run on Windows as well as POSIX', () => {
  it('sets no environment variable with shell assignment syntax', () => {
    const offenders = Object.entries(SCRIPTS)
      .filter(([, cmd]) => POSIX_ASSIGNMENT_PREFIX.test(cmd))
      .map(([name, cmd]) => `${name}: ${cmd}`);

    // If this fails, prefix the command with `cross-env` rather than dropping
    // the variable — see the note above on why it is not moving into .env.
    expect(offenders).toEqual([]);
  });

  it('still passes the live interlock to every suite that writes to production', () => {
    // The fix must not have quietly removed the guard while making it
    // portable. Any script that reaches live data still has to ask for it.
    const live = Object.entries(SCRIPTS).filter(([name]) =>
      ['e2e:rounds', 'e2e:stake', 'e2e:tournament', 'e2e:nemesis-timing'].includes(name),
    );
    expect(live).toHaveLength(4);
    for (const [name, cmd] of live) {
      expect(cmd, `${name} lost its live interlock`).toContain('EVENSHOCK_LIVE=1');
      expect(cmd, `${name} is not cross-shell`).toMatch(/^cross-env /);
    }
  });

  it('declares cross-env, so the scripts are not relying on a global install', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.devDependencies?.['cross-env']).toBeTruthy();
  });
});
