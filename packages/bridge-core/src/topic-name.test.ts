import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESENCE_TOPIC } from './engine/presence.js';
import { asTopic } from './message.js';
import { MIN_HASH_LEN, safeName } from './topic-name.js';

// Representative copies of each backend's legal-charset fold (byte-for-byte the plugins' own
// module-private regexes). safeName must make each of them injective; asserting against these
// here proves injectivity without exporting the plugins' internals.
const sanitizeToken = (s: string): string => s.replace(/[.*>\s]/g, '_'); // NATS subject
const sanitizeName = (s: string): string => s.replace(/[.*>/\\\s]/g, '_'); // NATS stream
const sanitizeAlias = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_'); // Matrix alias
const sanitizeLocal = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.\-_]/g, '_'); // XMPP JID

const folds: [string, (s: string) => string][] = [
  ['NATS subject', sanitizeToken],
  ['NATS stream', sanitizeName],
  ['Matrix alias', sanitizeAlias],
  ['XMPP localpart', sanitizeLocal],
];

describe('safeName', () => {
  it('NATS: distinct topics with a colliding sanitized stream name map to distinct names', () => {
    const a = safeName(asTopic('team.frontend'), sanitizeName);
    const b = safeName(asTopic('team_frontend'), sanitizeName);
    expect(a).not.toBe(b);
    // The `/`-divergence variant: the subject and stream folds differ, but each must stay
    // injective for the `a/b` vs `a_b` pair.
    expect(safeName(asTopic('a/b'), sanitizeName)).not.toBe(safeName(asTopic('a_b'), sanitizeName));
    expect(safeName(asTopic('a.b'), sanitizeToken)).not.toBe(
      safeName(asTopic('a_b'), sanitizeToken),
    );
  });

  it('Matrix: distinct topics with a colliding alias localpart map to distinct names', () => {
    expect(safeName(asTopic('a b'), sanitizeAlias)).not.toBe(
      safeName(asTopic('a_b'), sanitizeAlias),
    );
  });

  it('XMPP: case- and separator-variant topics map to distinct JID localparts', () => {
    expect(safeName(asTopic('Ops'), sanitizeLocal)).not.toBe(
      safeName(asTopic('ops'), sanitizeLocal),
    );
    expect(safeName(asTopic('dev ops'), sanitizeLocal)).not.toBe(
      safeName(asTopic('dev/ops'), sanitizeLocal),
    );
  });

  it('no-churn: a naturally-safe topic returns the bare sanitized form for every backend fold', () => {
    const t = asTopic('t-1-abcd');
    expect(safeName(t, sanitizeToken)).toBe('t-1-abcd');
    expect(safeName(t, sanitizeName)).toBe('t-1-abcd');
    expect(safeName(t, sanitizeAlias)).toBe('t-1-abcd');
    expect(safeName(t, sanitizeLocal)).toBe('t-1-abcd');
  });

  it('appends a lowercase-hex suffix only when the fold was lossy', () => {
    const out = safeName(asTopic('team.frontend'), sanitizeName);
    expect(out).toMatch(new RegExp(`^team_frontend-[0-9a-f]{${MIN_HASH_LEN}}$`));
  });

  it('is deterministic and idempotent-safe (same raw topic → same name)', () => {
    expect(safeName(asTopic('a b'), sanitizeAlias)).toBe(safeName(asTopic('a b'), sanitizeAlias));
  });

  it('honours custom hashLen / sep options', () => {
    const out = safeName(asTopic('a b'), sanitizeAlias, { hashLen: 16, sep: '.' });
    expect(out).toMatch(/^a_b\.[0-9a-f]{16}$/);
  });
});

// The suffix IS the injectivity argument, so its width is not a caller preference: at 4 hex chars a
// second preimage of a chosen name is found in tens of thousands of tries. Refuse anything a caller
// could weaken it to, at the boundary rather than at one sampled value.
describe('safeName refuses a suffix too short to disambiguate', () => {
  it.each([0, 1, 2, 4, 8, MIN_HASH_LEN - 1, -4, 2.5, 41, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects hashLen %s',
    (hashLen) => {
      expect(() => safeName(asTopic('a b'), sanitizeAlias, { hashLen })).toThrow(RangeError);
    },
  );

  it.each([MIN_HASH_LEN, MIN_HASH_LEN + 1, 20, 40])('accepts hashLen %s', (hashLen) => {
    const out = safeName(asTopic('a b'), sanitizeAlias, { hashLen });
    expect(out).toMatch(new RegExp(`^a_b-[0-9a-f]{${hashLen}}$`));
  });

  // Characters EVERY shipped fold rewrites to `_`, so a topic built from them folds to one name
  // under all four and the suffix is the only thing keeping the names apart.
  const COLLAPSED = [
    '*',
    '>',
    ' ',
    '\t',
    '\n',
    '\v',
    '\f',
    '\r',
    '\u00a0',
    '\u1680',
    '\u2000',
    '\u2001',
    '\u2002',
    '\u2003',
    '\u2004',
    '\u2005',
    '\u2006',
    '\u2007',
    '\u2008',
    '\u2009',
    '\u200a',
    '\u2028',
    '\u2029',
    '\u202f',
    '\u205f',
    '\u3000',
    '\ufeff',
  ];

  it.each(folds)('mints a distinct name for each of a corpus that folds to one (%s)', (_l, fold) => {
    const names = new Set<string>();
    let generated = 0;
    for (const a of COLLAPSED)
      for (const b of COLLAPSED)
        for (const c of COLLAPSED) {
          generated++;
          names.add(safeName(asTopic(`t${a}${b}${c}`), fold));
        }
    expect(generated).toBeGreaterThan(15_000);
    expect(new Set(COLLAPSED.map((c) => fold(`t${c}${c}${c}`))).size).toBe(1); // the fold really is total here
    expect(names.size).toBe(generated);
  });
});

// safeName names truncation as a lossiness it handles, so a fold that truncates must not get back a
// name it would truncate again — that silently re-collides the topics the suffix just separated.
describe('safeName output is a fixed point of the fold it was given', () => {
  it.each(folds)('re-folding a minted name changes nothing (%s)', (_l, fold) => {
    for (const raw of ['a b', 'Ops', 'team.frontend', 'dev/ops', 'a-0123456789']) {
      const name = safeName(asTopic(raw), fold);
      expect(fold(name)).toBe(name);
    }
  });

  it('throws instead of returning an over-limit name for a truncating fold', () => {
    const truncateTo10 = (s: string): string => s.slice(0, 10);
    expect(() => safeName(asTopic('aaaaaaaaaaXX'), truncateTo10)).toThrow(
      /the disambiguating suffix does not/,
    );
  });

  it('throws when the fold charset excludes the separator', () => {
    const noDash = (s: string): string => s.replace(/[- ]/g, '_');
    expect(() => safeName(asTopic('a b'), noDash)).toThrow(/Topics would collide/);
    expect(safeName(asTopic('a b'), noDash, { sep: '_' })).toMatch(/^a_b_[0-9a-f]{10}$/);
  });
});

// Injectivity is the whole point of safeName, so assert it as a property over a generated corpus
// CLOSED UNDER safeName ITSELF: every name the mapping produces is fed back in as a raw topic.
// Fixed lossy/lossless pairs can never see the collision that matters — a topic literally equal to
// another topic's disambiguated `<sanitized><sep><hash>` output, which an attacker can compute.
describe('safeName injectivity (generated, closed under its own output)', () => {
  const SEEDS = [
    'ops',
    'Ops',
    'OPS',
    'team.frontend',
    'team_frontend',
    'team/frontend',
    'a b',
    'a_b',
    'a.b',
    'a/b',
    'dev ops',
    'dev/ops',
    'ctx-payments',
    't-1-abcd',
    'x',
    'X',
    'a-0123456789',
    'a-0123456789ab',
  ];

  it.each(folds)('is injective over the corpus and its closure (%s)', (_label, fold) => {
    const corpus = new Set(SEEDS);
    for (let round = 0; round < 2; round++) {
      for (const raw of [...corpus]) corpus.add(safeName(asTopic(raw), fold));
    }
    const byName = new Map<string, string>();
    for (const raw of corpus) {
      const name = safeName(asTopic(raw), fold);
      const clash = byName.get(name);
      expect(clash, `${JSON.stringify(raw)} and ${JSON.stringify(clash)} both map to ${name}`).toBe(
        undefined,
      );
      byName.set(name, raw);
    }
  });

  it.each(folds)('a disambiguated name is never a fixed point of the mapping (%s)', (_l, fold) => {
    const disambiguated = safeName(asTopic('a b'), fold);
    expect(safeName(asTopic(disambiguated), fold)).not.toBe(disambiguated);
  });

  it.each(folds)('honours the closure property under custom sep/hashLen too (%s)', (_l, fold) => {
    const opts = { hashLen: 16, sep: '_' }; // legal under every fold, so the name survives refolding
    const first = safeName(asTopic('a b'), fold, opts);
    expect(safeName(asTopic(first), fold, opts)).not.toBe(first);
  });
});

// The presence topic is reserved by EXACT string equality in the Allowlist, so the guarantee that a
// broad `post_topics` pattern cannot reach the roster rests on near-miss variants staying distinct
// TOPICS all the way down to the backend name. This is the layer that decides that.
describe('near-misses of the presence topic never share its backend name', () => {
  const NEAR_MISSES = [
    DEFAULT_PRESENCE_TOPIC,
    DEFAULT_PRESENCE_TOPIC.toUpperCase(),
    'Parley-Presence',
    'parley presence',
    'parley.presence',
    'parley/presence',
    'parley_presence',
    `${DEFAULT_PRESENCE_TOPIC} `,
    ` ${DEFAULT_PRESENCE_TOPIC}`,
    `${DEFAULT_PRESENCE_TOPIC}\u200b`,
    'parley\u00a0presence',
  ];

  it.each(folds)('every variant maps to its own name (%s)', (_l, fold) => {
    const byName = new Map<string, string>();
    for (const raw of NEAR_MISSES) {
      const name = safeName(asTopic(raw), fold);
      expect(byName.get(name), `${JSON.stringify(raw)} collides with the reserved topic`).toBe(
        undefined,
      );
      byName.set(name, raw);
    }
    expect(byName.size).toBe(NEAR_MISSES.length);
  });
});
