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

/**
 * The whole job of this validator is to refuse a degenerate record at BUILD time. A cost that is
 * out of node:crypto's range but slips through resurfaces as a thrown RangeError from the async
 * KDF — on the consent POST, which is the owner's only way in, and as a non-ConsentError it becomes
 * a bare 500 that names nothing. `N & (N - 1)` evaluated in int32 was exactly that hole: every N
 * congruent to a power of two mod 2^32 passed, including 2^32 + 2, which scrypt cannot accept.
 */
const OUT_OF_RANGE_COSTS: Array<[string, string]> = [
  ...[
    0,
    1,
    2 ** 31,
    2 ** 32,
    2 ** 32 + 2,
    2 ** 33 + 2,
    6442450944,
    Number.MAX_SAFE_INTEGER,
  ].map((N): [string, string] => [`N=${N}`, `scrypt$N=${N},r=8,p=1$SALT$HASH`]),
  ['N beyond Number.MAX_SAFE_INTEGER', `scrypt$N=${(10n ** 21n).toString()},r=8,p=1$SALT$HASH`],
  ['N=65536 at r=1 (node caps N below 2**(16r))', 'scrypt$N=65536,r=1,p=1$SALT$HASH'],
  ['N=1048576 at r=8 (one step over the memory ceiling)', 'scrypt$N=1048576,r=8,p=1$SALT$HASH'],
  ['r=100000 (a ~200 GB derivation)', 'scrypt$N=16384,r=100000,p=1$SALT$HASH'],
  ['p=0', 'scrypt$N=16384,r=8,p=0$SALT$HASH'],
  ['p=1000000', 'scrypt$N=16384,r=8,p=1000000$SALT$HASH'],
];

/** Costs at the edge of what is allowed, so the guard cannot be satisfied by refusing everything. */
const IN_RANGE_COSTS: Array<[string, ScryptParams]> = [
  ['the smallest cost', { N: 2, r: 1, p: 1 }],
  ['the largest N that fits at r=1', { N: 32768, r: 1, p: 1 }],
  ['a large N within the memory ceiling', { N: 524288, r: 8, p: 1 }],
  ['the widest block size', { N: 1024, r: 64, p: 1 }],
  ['the most parallelism', { N: 1024, r: 8, p: 16 }],
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
    ...OUT_OF_RANGE_COSTS,
  ])('refuses to build a verifier from %s', (_label: string, template: string) => {
    const stored = template
      .replace('SALT', randomBytes(16).toString('base64'))
      .replace('HASH', randomBytes(32).toString('base64'));
    expect(() => makeOwnerVerifier(stored)).toThrow(/invalid owner secret hash/);
  });
});

describe('owner secret — a build-time validator must not defer its failure to the login path', () => {
  it.each(IN_RANGE_COSTS)('accepts %s', (_label: string, params: ScryptParams) => {
    const stored = `scrypt$N=${params.N},r=${params.r},p=${params.p}$${randomBytes(16).toString(
      'base64',
    )}$${randomBytes(32).toString('base64')}`;
    expect(() => makeOwnerVerifier(stored)).not.toThrow();
  });

  const CORPUS: string[] = [
    ...OUT_OF_RANGE_COSTS.map(([, template]) => template),
    // Deriving at the top of the accepted range costs seconds; the build-time row above covers it,
    // so this property only needs records cheap enough to actually run.
    ...IN_RANGE_COSTS.filter(([, p]) => p.N * p.r <= 65536).map(
      ([, p]) => `scrypt$N=${p.N},r=${p.r},p=${p.p}$SALT$HASH`,
    ),
    ...PARAM_SETS.map(([, p]) => `scrypt$N=${p.N},r=${p.r},p=${p.p}$SALT$HASH`),
    'scrypt$SALT$HASH',
  ].map((template) =>
    template
      .replace('SALT', randomBytes(16).toString('base64'))
      .replace('HASH', randomBytes(32).toString('base64')),
  );

  it.each(CORPUS.map((stored, i) => [`record ${i}: ${stored.split('$')[1]}`, stored]))(
    'either throws for %s or returns a verifier that resolves',
    async (_label: string, stored: string) => {
      let verify: ((passphrase: string) => Promise<boolean>) | undefined;
      try {
        verify = makeOwnerVerifier(stored);
      } catch (err) {
        expect((err as Error).message).toMatch(/invalid owner secret hash/);
        return;
      }
      await expect(verify('any passphrase at all')).resolves.toBeTypeOf('boolean');
    },
  );
});

/**
 * A serializer that emits records its own deserializer refuses hands the operator a credential that
 * fails at server boot, on a passphrase that can no longer be re-derived. Both halves are driven
 * from ONE corpus — the reader's own in-range and out-of-range tables — so a future ceiling change
 * cannot be applied to only one of them.
 */
function costOf(template: string): ScryptParams {
  const m = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$/.exec(template);
  if (m === null) throw new Error(`cost template without a parameter block: ${template}`);
  return { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
}

const COST_CORPUS: Array<[string, ScryptParams]> = [
  ...IN_RANGE_COSTS,
  ...PARAM_SETS,
  ...OUT_OF_RANGE_COSTS.map(([label, template]): [string, ScryptParams] => [label, costOf(template)]),
];

function readerRefuses(params: ScryptParams): boolean {
  const stored = `scrypt$N=${params.N},r=${params.r},p=${params.p}$${randomBytes(16).toString(
    'base64',
  )}$${randomBytes(32).toString('base64')}`;
  try {
    makeOwnerVerifier(stored);
    return false;
  } catch {
    return true;
  }
}

// A refused row costs nothing either way — the writer must reject it without deriving — so only the
// accepted rows need the cheapness filter the reader-side tables already use.
const ROUND_TRIP = COST_CORPUS.filter(
  ([, params]) => readerRefuses(params) || params.N * params.r <= 65536,
);

describe('owner secret — the writer accepts exactly what the reader accepts', () => {
  const PASS = 'correct horse battery staple';

  it('the corpus spans both verdicts, so the property cannot pass vacuously', () => {
    expect(new Set(ROUND_TRIP.map(([, p]) => readerRefuses(p)))).toEqual(new Set([true, false]));
  });

  it.each(ROUND_TRIP)(
    'hashOwnerSecret at %s throws exactly when makeOwnerVerifier would',
    async (_label: string, params: ScryptParams) => {
      if (readerRefuses(params)) {
        expect(() => hashOwnerSecret(PASS, params)).toThrow(/invalid owner secret hash/);
        return;
      }
      const stored = hashOwnerSecret(PASS, params);
      expect(await makeOwnerVerifier(stored)(PASS)).toBe(true);
    },
  );
});

/**
 * An empty passphrase must never authorize, whatever the stored record says — and the short-circuit
 * that guarantees it is only provable against a record whose hash IS the derivation of the empty
 * string. Asserting `verify('') === false` against an ordinary record proves nothing: scrypt('')
 * simply derives a non-matching hash, so the assertion holds with the guard deleted.
 */
describe('owner secret — the empty-passphrase guard', () => {
  // A record written WITHOUT a parameter block is re-derived at owner.ts's DEFAULT_PARAMS, so the
  // adversarial record for that form has to be derived at those same parameters.
  const READ_AT: Array<[string, boolean, ScryptParams]> = [
    ['a parameterised record', true, { N: 1024, r: 8, p: 1 }],
    ['a legacy parameterless record', false, { N: 16384, r: 8, p: 1 }],
  ];

  function recordFor(passphrase: string, withParams: boolean, params: ScryptParams): string {
    const salt = randomBytes(16);
    const hash = scryptSync(passphrase, salt, 32, {
      ...params,
      maxmem: 256 * params.N * params.r + 1024 * 1024,
    });
    return [
      'scrypt',
      ...(withParams ? [`N=${params.N},r=${params.r},p=${params.p}`] : []),
      salt.toString('base64'),
      hash.toString('base64'),
    ].join('$');
  }

  it.each(READ_AT)(
    'refuses an empty passphrase against %s whose hash IS scrypt("")',
    async (_label: string, withParams: boolean, params: ScryptParams) => {
      // Negative control: the identical construction with a real passphrase verifies, so the record
      // shape and parameters are ones the verifier reads correctly. Without it, a record the
      // verifier simply cannot read would make the assertion below pass for the wrong reason.
      expect(await makeOwnerVerifier(recordFor('a real one', withParams, params))('a real one')).toBe(
        true,
      );

      expect(await makeOwnerVerifier(recordFor('', withParams, params))('')).toBe(false);
    },
  );

  it('still refuses an empty passphrase against an ordinary record', async () => {
    expect(await makeOwnerVerifier(hashOwnerSecret('a real one'))('')).toBe(false);
  });
});
