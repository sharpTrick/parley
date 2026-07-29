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

  // Any stored string whose segments decode to the wrong length must be rejected when the verifier
  // is BUILT. Accepting one and deciding at verify time is how a zero-length hash reaches
  // timingSafeEqual(empty, empty) === true and authorizes every passphrase.
  it.each([
    ['empty hash segment', `scrypt$${'a'.repeat(24)}$`],
    ['hash segment is base64 padding only', `scrypt$${'a'.repeat(24)}$=`],
    ['both segments empty', 'scrypt$$'],
    ['empty salt segment', `scrypt$$${Buffer.alloc(32).toString('base64')}`],
    ['non-base64 hash segment', `scrypt$${'a'.repeat(24)}$!!!!`],
    ['hash one byte short', `scrypt$${'a'.repeat(24)}$${Buffer.alloc(31).toString('base64')}`],
    ['hash one byte long', `scrypt$${'a'.repeat(24)}$${Buffer.alloc(33).toString('base64')}`],
    ['salt one byte short', `scrypt$${Buffer.alloc(15).toString('base64')}$${Buffer.alloc(32).toString('base64')}`],
  ])('refuses to build a verifier from a degenerate stored hash (%s)', (_label, stored) => {
    expect(() => makeOwnerVerifier(stored)).toThrow(/invalid owner secret hash/);
  });

  it('a real hash still round-trips after the length checks', async () => {
    const verify = makeOwnerVerifier(hashOwnerSecret('correct horse'));
    expect(await verify('correct horse')).toBe(true);
    expect(await verify('correct horse ')).toBe(false);
  });
});
