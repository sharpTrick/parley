import { describe, expect, it } from 'vitest';
import { hashOwnerSecret, makeOwnerVerifier, ownerVerifierFromPassphrase } from './owner.js';

describe('owner secret', () => {
  it('hashes as scrypt$salt$hash', () => {
    const h = hashOwnerSecret('s3cret');
    expect(h.split('$')).toHaveLength(3);
    expect(h.startsWith('scrypt$')).toBe(true);
  });

  it('verifier accepts the right passphrase and rejects others', () => {
    const verify = makeOwnerVerifier(hashOwnerSecret('open sesame'));
    expect(verify('open sesame')).toBe(true);
    expect(verify('wrong')).toBe(false);
    expect(verify('')).toBe(false);
  });

  it('fresh salt each time, but both verify (no plaintext stored)', () => {
    const p = 'same pass';
    expect(hashOwnerSecret(p)).not.toBe(hashOwnerSecret(p));
    expect(ownerVerifierFromPassphrase(p)(p)).toBe(true);
  });

  it('rejects a malformed stored hash and an empty passphrase', () => {
    expect(() => makeOwnerVerifier('garbage')).toThrow();
    expect(() => hashOwnerSecret('')).toThrow();
  });
});
