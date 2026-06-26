import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Owner-secret handling for the single-tenant front door (DESIGN §10/§14). The owner's secret is
// the only thing that can authorize the bridge. We store a scrypt hash (never the plaintext), and
// the credential handoff is LOCAL (CLI/stdin/localhost), so no secret crosses the public internet.

const FORMAT = 'scrypt';
const KEYLEN = 32;

/** Hash an owner passphrase as `scrypt$<saltB64>$<hashB64>` for at-rest storage. */
export function hashOwnerSecret(passphrase: string): string {
  if (passphrase.length === 0) throw new Error('owner passphrase must not be empty');
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase, salt, KEYLEN);
  return `${FORMAT}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Build a timing-safe verifier from a stored `scrypt$salt$hash` string. */
export function makeOwnerVerifier(stored: string): (passphrase: string) => boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== FORMAT || parts[1] === undefined || parts[2] === undefined) {
    throw new Error('invalid owner secret hash (expected scrypt$salt$hash)');
  }
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  return (passphrase: string): boolean => {
    if (passphrase.length === 0) return false;
    const actual = scryptSync(passphrase, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}

/** Convenience: a verifier from a plaintext passphrase (hashes once with a fresh salt). */
export function ownerVerifierFromPassphrase(passphrase: string): (passphrase: string) => boolean {
  return makeOwnerVerifier(hashOwnerSecret(passphrase));
}
