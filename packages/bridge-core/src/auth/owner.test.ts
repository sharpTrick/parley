import { describe, expect, it } from 'vitest';
import { hashOwnerSecret, makeOwnerVerifier, ownerVerifierFromPassphrase } from './owner.js';

describe('owner secret', () => {
  it('hashes as scrypt$salt$hash', () => {
    const h = hashOwnerSecret('s3cret');
    expect(h.split('$')).toHaveLength(3);
    expect(h.startsWith('scrypt$')).toBe(true);
  });

  it('verifier accepts the right passphrase and rejects others (async, off the event loop)', async () => {
    const verify = makeOwnerVerifier(hashOwnerSecret('open sesame'));
    const pending = verify('open sesame');
    expect(pending).toBeInstanceOf(Promise); // scrypt runs async — no scryptSync on the verify path
    expect(await pending).toBe(true);
    expect(await verify('wrong')).toBe(false);
    expect(await verify('')).toBe(false);
  });

  it('fresh salt each time, but both verify (no plaintext stored)', async () => {
    const p = 'same pass';
    expect(hashOwnerSecret(p)).not.toBe(hashOwnerSecret(p));
    expect(await ownerVerifierFromPassphrase(p)(p)).toBe(true);
  });

  it('rejects a malformed stored hash and an empty passphrase', () => {
    expect(() => makeOwnerVerifier('garbage')).toThrow();
    expect(() => hashOwnerSecret('')).toThrow();
  });
});
