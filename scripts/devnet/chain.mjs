/**
 * The gate the rest of the harness sits behind.
 *
 * This harness holds the mint authority for its own test currency. It can
 * conjure balance from nothing. So the interesting question is not "is it
 * configured for devnet" — it is "what makes it IMPOSSIBLE to run anywhere
 * else", and a configuration value is not an answer to that. `SOLANA_RPC_URL`
 * is a string; anyone can change a string.
 *
 * So the chain is asked who it is. `getGenesisHash()` returns a value that is a
 * property of the network itself, not of our configuration, and mainnet-beta
 * cannot return devnet's. That check runs before any key is loaded, and the key
 * loader refuses to hand anything out until it has passed IN THIS PROCESS.
 * Pointing the harness at mainnet therefore produces a harness holding no keys
 * at all, rather than one that politely declines to sign.
 *
 * Three gates live here; the fourth — a constraint refusing a registered test
 * mint on a mainnet payment_config — is in the database, because that one has
 * to survive somebody rewriting this file.
 */
import { Connection, Keypair } from '@solana/web3.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KEY_DIR = join(ROOT, '.devnet');

/** Network identities. These are facts about the chains, not settings. */
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const KNOWN_GENESIS = {
  [DEVNET_GENESIS]: 'devnet',
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
};

/** Set only by assertDevnet(), and only on success. Keys are locked until then. */
let proven = false;

export const DEFAULT_RPC = 'https://api.devnet.solana.com';

/**
 * Opens a connection and refuses to continue unless the chain says it is devnet.
 *
 * Exits the process rather than throwing. A caller that could catch this could
 * also carry on past it, and there is no sensible way to carry on past "you are
 * pointed at real money".
 */
export async function assertDevnet(rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC) {
  const connection = new Connection(rpcUrl, 'confirmed');

  let genesis;
  try {
    genesis = await connection.getGenesisHash();
  } catch (err) {
    console.error(`\n  Cannot reach ${rpcUrl}\n  ${err?.message ?? err}\n`);
    process.exit(1);
  }

  if (genesis !== DEVNET_GENESIS) {
    const name = KNOWN_GENESIS[genesis] ?? 'an unrecognised network';
    console.error(
      [
        '',
        '  REFUSING TO RUN.',
        '',
        `  ${rpcUrl}`,
        `  answers with genesis ${genesis}`,
        `  which is ${name}, not devnet.`,
        '',
        '  This harness holds the mint authority for its own test currency and',
        '  must never sign anything on a network where value is real. No keys',
        '  have been loaded.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  proven = true;
  return { connection, genesis, rpcUrl };
}

/**
 * Loads a keypair, creating it on first use.
 *
 * Two files per key, deliberately:
 *
 *   <name>.json       a bare 64-byte array — the format `solana-keygen` writes,
 *                     so the `solana` CLI can read these directly if you ever
 *                     need to poke at one by hand.
 *   <name>.meta.json  the genesis hash present when the key was created.
 *
 * The metadata is a separate file precisely so the first one stays CLI-format.
 * The loader re-checks it, which binds the key to a chain: copying `.devnet/`
 * somewhere else does not make it usable.
 */
export function loadKeypair(name) {
  if (!proven) {
    throw new Error(
      `refusing to load key "${name}": assertDevnet() has not proven this connection is devnet`,
    );
  }

  mkdirSync(KEY_DIR, { recursive: true });
  const keyPath = join(KEY_DIR, `${name}.json`);
  const metaPath = join(KEY_DIR, `${name}.meta.json`);

  if (!existsSync(keyPath)) {
    const kp = Keypair.generate();
    writeFileSync(keyPath, JSON.stringify([...kp.secretKey]));
    writeFileSync(
      metaPath,
      JSON.stringify({ genesis: DEVNET_GENESIS, cluster: 'devnet', created_at: new Date().toISOString() }, null, 2),
    );
    console.log(`  generated ${name}  ${kp.publicKey.toBase58()}`);
    return kp;
  }

  if (!existsSync(metaPath)) {
    throw new Error(
      `${keyPath} has no ${name}.meta.json — refusing to use a key that is not bound to a chain`,
    );
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (meta.genesis !== DEVNET_GENESIS) {
    throw new Error(`${name} was created on genesis ${meta.genesis}, which is not devnet`);
  }

  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8'))));
}

// ------------------------------------------------------------------- state

const STATE_PATH = join(KEY_DIR, 'state.json');

export function readState() {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

export function writeState(patch) {
  mkdirSync(KEY_DIR, { recursive: true });
  const next = { ...readState(), ...patch, updated_at: new Date().toISOString() };
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
  return next;
}

export function writeReport(report) {
  mkdirSync(KEY_DIR, { recursive: true });
  writeFileSync(join(KEY_DIR, 'report.json'), JSON.stringify(report, null, 2));
}

// ------------------------------------------------------------------- misc

/** Base units to an exact decimal string. Never floats — this is money. */
export function formatUnits(raw, decimals) {
  const s = BigInt(raw).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return decimals > 0 ? `${whole}.${frac}` : whole;
}

/** Decimal string to base units, exactly, with no intermediate float. */
export function parseUnits(value, decimals) {
  const [whole, frac = ''] = String(value).split('.');
  if (frac.length > decimals) throw new Error(`${value} has more than ${decimals} decimals`);
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
