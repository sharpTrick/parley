import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashOwnerSecret,
  makeOwnerVerifier,
  ownerVerifierFromPassphrase,
  type ScryptParams,
} from './owner.js';

describe('owner secret', () => {
  it('hashes as scrypt$params$salt$hash', () => {
    const h = hashOwnerSecret('s3cret');
    expect(h.split('$')).toHaveLength(4);
    expect(h.startsWith('scrypt$N=16384,r=8,p=1$')).toBe(true);
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

/**
 * A stored credential has to survive the day its cost parameters change. Everything below reads
 * the record and nothing else: a verifier that fell back to an ambient default would accept a
 * record whose parameter block says something different, and would reject every record written
 * before the default moved.
 */
const PARAM_SETS: Array<[string, ScryptParams]> = [
  ['the shipped default', { N: 16384, r: 8, p: 1 }],
  ['a cheaper cost', { N: 1024, r: 8, p: 1 }],
  ['a wider block size', { N: 4096, r: 16, p: 1 }],
  ['more parallelism', { N: 4096, r: 8, p: 3 }],
];

describe('owner secret — the stored record describes the parameters that produced it', () => {
  const PASS = 'correct horse battery staple';

  it.each(PARAM_SETS)('a record written at %s verifies from the record alone', async (_label, params) => {
    const stored = hashOwnerSecret(PASS, params);
    expect(stored).toContain(`N=${params.N},r=${params.r},p=${params.p}`);
    const verify = makeOwnerVerifier(stored);
    expect(await verify(PASS)).toBe(true);
    expect(await verify(`${PASS}!`)).toBe(false);
  });

  it.each(PARAM_SETS)(
    'a record written at %s is refused once its parameter block is rewritten',
    async (_label, params) => {
      const stored = hashOwnerSecret(PASS, params);
      const tampered = stored.replace(`N=${params.N},`, `N=${params.N * 2},`);
      expect(tampered).not.toBe(stored);
      expect(await makeOwnerVerifier(tampered)(PASS)).toBe(false);
    },
  );

  it('still reads a record written before parameters were recorded', async () => {
    const salt = randomBytes(16);
    const legacy = `scrypt$${salt.toString('base64')}$${scryptSync(PASS, salt, 32).toString('base64')}`;
    expect(legacy.split('$')).toHaveLength(3);
    const verify = makeOwnerVerifier(legacy);
    expect(await verify(PASS)).toBe(true);
    expect(await verify('wrong')).toBe(false);
  });

  it.each([
    ['a missing parameter', 'scrypt$N=16384,r=8$SALT$HASH'],
    ['an unknown parameter', 'scrypt$N=16384,r=8,p=1,q=9$SALT$HASH'],
    ['a non-numeric cost', 'scrypt$N=huge,r=8,p=1$SALT$HASH'],
    ['a cost that is not a power of two', 'scrypt$N=16383,r=8,p=1$SALT$HASH'],
    ['a zero block size', 'scrypt$N=16384,r=0,p=1$SALT$HASH'],
    ['an empty parameter block', 'scrypt$$SALT$HASH'],
    ['a fifth field', 'scrypt$N=16384,r=8,p=1$SALT$HASH$extra'],
  ])('refuses to build a verifier from %s', (_label: string, template: string) => {
    const stored = template
      .replace('SALT', randomBytes(16).toString('base64'))
      .replace('HASH', randomBytes(32).toString('base64'));
    expect(() => makeOwnerVerifier(stored)).toThrow(/invalid owner secret hash/);
  });
});
