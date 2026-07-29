import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// Owner-secret handling for the single-tenant front door (DESIGN §10/§14). The owner's secret is
// the only thing that can authorize the bridge. We store a scrypt hash (never the plaintext), and
// the credential handoff is LOCAL (CLI/stdin/localhost), so no secret crosses the public internet.

const FORMAT = 'scrypt';
const KEYLEN = 32;
const SALTLEN = 16;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/**
 * Written into every new record rather than inherited from node:crypto, so that a stored hash says
 * which parameters produced it. A record that does not carry them can only be re-derived at
 * whatever the ambient default happens to be: raise the cost, or move to a Node whose defaults
 * differ, and the owner's correct passphrase becomes a permanent rejection with no diagnostic.
 */
const DEFAULT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };

// Verify off the event loop: scrypt is a deliberately expensive KDF, so the hot verify path uses
// the async form to avoid a consent-guess flood stalling Node's single thread (CPU/latency DoS).
const scryptAsync = promisify(scrypt) as (
  pw: string,
  salt: Buffer,
  keylen: number,
  options: ScryptParams & { maxmem: number },
) => Promise<Buffer>;

function scryptOptions(params: ScryptParams): ScryptParams & { maxmem: number } {
  return { ...params, maxmem: 256 * params.N * params.r + 1024 * 1024 };
}

function formatParams(params: ScryptParams): string {
  return `N=${params.N},r=${params.r},p=${params.p}`;
}

function parseParams(block: string): ScryptParams {
  const seen = new Map<string, number>();
  for (const pair of block.split(',')) {
    const [key, raw] = pair.split('=');
    if (key === undefined || raw === undefined || !/^\d+$/.test(raw)) {
      throw new Error(`invalid owner secret hash (unreadable scrypt parameter "${pair}")`);
    }
    seen.set(key, Number(raw));
  }
  const N = seen.get('N');
  const r = seen.get('r');
  const p = seen.get('p');
  if (N === undefined || r === undefined || p === undefined || seen.size !== 3) {
    throw new Error(
      `invalid owner secret hash (scrypt parameters must be exactly N, r and p, got "${block}")`,
    );
  }
  if (N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1) {
    throw new Error(`invalid owner secret hash (scrypt parameters out of range: "${block}")`);
  }
  return { N, r, p };
}

/** Hash an owner passphrase as `scrypt$N=..,r=..,p=..$<saltB64>$<hashB64>` for at-rest storage. */
export function hashOwnerSecret(passphrase: string, params: ScryptParams = DEFAULT_PARAMS): string {
  if (passphrase.length === 0) throw new Error('owner passphrase must not be empty');
  const salt = randomBytes(SALTLEN);
  const hash = scryptSync(passphrase, salt, KEYLEN, scryptOptions(params));
  return `${FORMAT}$${formatParams(params)}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Build a timing-safe verifier from a stored record. Both the parameterised form and the original
 * `scrypt$salt$hash` are read; the latter is derived at the parameters node:crypto defaulted to
 * when it was written, which is what keeps an already-provisioned deployment working.
 */
export function makeOwnerVerifier(stored: string): (passphrase: string) => Promise<boolean> {
  const parts = stored.split('$');
  if (parts[0] !== FORMAT || (parts.length !== 3 && parts.length !== 4)) {
    throw new Error('invalid owner secret hash (expected scrypt$params$salt$hash)');
  }
  const params = parts.length === 4 ? parseParams(parts[1]!) : DEFAULT_PARAMS;
  const salt = Buffer.from(parts.at(-2)!, 'base64');
  const expected = Buffer.from(parts.at(-1)!, 'base64');
  // Reject degenerate material here, so that a zero-length hash can never reach
  // timingSafeEqual(empty, empty) — which is true, and authorizes every passphrase.
  if (salt.length !== SALTLEN || expected.length !== KEYLEN) {
    throw new Error(
      `invalid owner secret hash (expected a ${SALTLEN}-byte salt and a ${KEYLEN}-byte hash, ` +
        `got ${salt.length} and ${expected.length})`,
    );
  }
  const options = scryptOptions(params);
  return async (passphrase: string): Promise<boolean> => {
    if (passphrase.length === 0) return false;
    const actual = await scryptAsync(passphrase, salt, KEYLEN, options);
    return timingSafeEqual(actual, expected);
  };
}

/** Convenience: a verifier from a plaintext passphrase (hashes once with a fresh salt). */
export function ownerVerifierFromPassphrase(
  passphrase: string,
): (passphrase: string) => Promise<boolean> {
  return makeOwnerVerifier(hashOwnerSecret(passphrase));
}
