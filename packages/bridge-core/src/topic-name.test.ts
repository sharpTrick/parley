import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESENCE_TOPIC } from './engine/presence.js';
import { asTopic } from './message.js';
import { DEFAULT_HASH_LEN, MAX_HASH_LEN, MIN_HASH_LEN, safeName } from './topic-name.js';

// Representative copies of each backend's legal-charset fold (byte-for-byte the plugins' own
// module-private regexes). safeName must make each of them injective; asserting against these
// here proves injectivity without exporting the plugins' internals.
const sanitizeToken = (s: string): string => s.replace(/[.*>\s]/g, '_'); // NATS subject
const sanitizeName = (s: string): string => s.replace(/[.*>/\\\s]/g, '_'); // NATS stream
const sanitizeAlias = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_'); // Matrix alias
const sanitizeLocal = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.\-_]/g, '_'); // XMPP JID

// Every shipped fold REPLACES an illegal character, so none of them can map a non-empty topic to the
// empty string — and a fold that cannot do that never reaches the length at which safeName's
// pass-through and disambiguating branches meet. A third-party fold that DELETES instead is an
// equally natural shape for public API, so grade both kinds.
const sanitizeDelete = (s: string): string => s.replace(/[^a-z0-9_-]/g, '');
const sanitizeLowerDelete = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_-]/g, '');

const folds: [string, (s: string) => string][] = [
  ['NATS subject', sanitizeToken],
  ['NATS stream', sanitizeName],
  ['Matrix alias', sanitizeAlias],
  ['XMPP localpart', sanitizeLocal],
  ['deleting fold', sanitizeDelete],
  ['lowercasing deleting fold', sanitizeLowerDelete],
];

it('the fold table carries a fold that can empty a non-empty topic', () => {
  expect(folds.map(([label]) => label)).toEqual([
    'NATS subject',
    'NATS stream',
    'Matrix alias',
    'XMPP localpart',
    'deleting fold',
    'lowercasing deleting fold',
  ]);
  expect(folds.filter(([, fold]) => fold('!!!') === '').length).toBeGreaterThanOrEqual(2);
});

// A backend name that identifies no channel addresses the backend as a whole, and every topic that
// folds to it would share it — the exact cross-delivery safeName exists to prevent. The fold is a
// fixed point of the empty string, so no plugin's charset check can catch it: this is the layer that
// has to. Grade the property over every fold and every topic in the corpora below, so the class
// ("some input makes safeName return an empty name") is closed rather than the one input.
describe('safeName never returns a name that identifies nothing', () => {
  const EMPTYING_TOPICS = ['', ' ', '  ', '\t', '\n', '!!!', '...', '@@@', '\u00a0', '\u200b'];

  it('the corpus contains inputs each branch of safeName can reach', () => {
    expect(EMPTYING_TOPICS).toContain('');
    expect(folds.some(([, fold]) => EMPTYING_TOPICS.some((t) => fold(t) === '' && t !== ''))).toBe(
      true,
    );
    expect(folds.some(([, fold]) => fold('') === '')).toBe(true);
  });

  it.each(folds)('every emptying topic yields a non-empty name or a throw (%s)', (_l, fold) => {
    for (const raw of EMPTYING_TOPICS) {
      let name: string | undefined;
      try {
        name = safeName(asTopic(raw), fold);
      } catch (e) {
        expect((e as Error).message).toMatch(/EMPTY backend name/);
        continue;
      }
      expect(name, `topic ${JSON.stringify(raw)} minted an empty backend name`).not.toBe('');
    }
  });

  it('refuses the empty topic by name, whatever the fold', () => {
    for (const [, fold] of folds)
      expect(() => safeName(asTopic(''), fold)).toThrow(/EMPTY backend name/);
  });
});

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
    expect(out).toMatch(new RegExp(`^team_frontend-[0-9a-f]{${DEFAULT_HASH_LEN}}$`));
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
// could weaken it to. Both ends of the legal range are graded AT the bound in stated-bounds.test.ts;
// what is graded here is the non-integer and non-finite shapes, and the width of what comes back.
describe('safeName refuses a suffix too short to disambiguate', () => {
  it.each([0, 1, 2, 4, 8, -4, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects hashLen %s',
    (hashLen) => {
      expect(() => safeName(asTopic('a b'), sanitizeAlias, { hashLen })).toThrow(RangeError);
    },
  );

  it.each([MIN_HASH_LEN, MIN_HASH_LEN + 1, 20, MAX_HASH_LEN])('accepts hashLen %s', (hashLen) => {
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
    expect(safeName(asTopic('a b'), noDash, { sep: '_' })).toMatch(/^a_b_[0-9a-f]{16}$/);
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
    '  ',
    ' ',
    '!!!',
  ];

  it('the corpus contains a topic a deleting fold empties, so the closure reaches the boundary', () => {
    const emptied = SEEDS.filter((s) => sanitizeDelete(s) === '');
    expect(emptied.length).toBeGreaterThanOrEqual(3);
    const minted = emptied.map((s) => safeName(asTopic(s), sanitizeDelete));
    expect(minted.every((n) => n.length === 1 + DEFAULT_HASH_LEN)).toBe(true);
    expect(new Set(minted).size).toBe(emptied.length);
  });

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

// A minted name is not an internal value: it becomes the Matrix room alias, the NATS stream and the
// XMPP MUC an operator's history already lives in. Changing the digest, its truncation or the suffix
// layout renames every existing channel — a silent data loss no shape assertion can see, because
// `/^team_frontend-[0-9a-f]{16}$/` matches the old name and the new one alike. So pin the VALUE, in
// the package that owns the function, one vector per fold and one per branch.
describe('safeName is pinned to the exact names backends already carry', () => {
  const GOLDEN: [string, (s: string) => string, string, { hashLen?: number; sep?: string }, string][] =
    [
      ['NATS subject', sanitizeToken, 'team.frontend', {}, 'team_frontend-08edf065f713aae7'],
      ['NATS subject', sanitizeToken, 'ctx-payments', {}, 'ctx-payments'],
      ['NATS stream', sanitizeName, 'team/frontend', {}, 'team_frontend-222ee3741b0781e7'],
      ['Matrix alias', sanitizeAlias, 'a b', {}, 'a_b-7dbde93504122a70'],
      ['Matrix alias', sanitizeAlias, 'a/b', {}, 'a_b-3ec69c85a4ff9683'],
      ['Matrix alias', sanitizeAlias, 't-1-abcd', {}, 't-1-abcd'],
      // A 10-hex tail is no longer a shape safeName can mint, so it is NOT already-disambiguated
      // and passes through; a 16-hex tail is, and gets disambiguated so a caller cannot name it.
      ['Matrix alias', sanitizeAlias, 'a-0123456789', {}, 'a-0123456789'],
      [
        'Matrix alias',
        sanitizeAlias,
        'a-0123456789abcdef',
        {},
        'a-0123456789abcdef-93c694cfb27491be',
      ],
      ['XMPP localpart', sanitizeLocal, 'Ops', {}, 'ops-907a54c2b2789a37'],
      ['XMPP localpart', sanitizeLocal, DEFAULT_PRESENCE_TOPIC, {}, 'parley-presence'],
      ['deleting fold', sanitizeDelete, '!!!', {}, '-9a7b006d203b362c'],
      ['lowercasing deleting fold', sanitizeLowerDelete, 'Ops!', {}, 'ops-c2acb669c886c412'],
      ['Matrix alias', sanitizeAlias, 'a b', { hashLen: 16, sep: '.' }, 'a_b.7dbde93504122a70'],
      [
        'Matrix alias',
        sanitizeAlias,
        'a b',
        { hashLen: MAX_HASH_LEN },
        'a_b-7dbde93504122a707f849f2c12bdd9de71b41929',
      ],
    ];

  it('carries a vector for every fold, and for each branch of the mapping', () => {
    expect([...new Set(GOLDEN.map(([label]) => label))].sort()).toEqual(
      folds.map(([label]) => label).sort(),
    );
    const lossless = GOLDEN.filter(([, fold, topic, , name]) => fold(topic) === name);
    const disambiguated = GOLDEN.filter(([, fold, topic, , name]) => fold(topic) !== name);
    expect(lossless.length).toBeGreaterThanOrEqual(2);
    expect(disambiguated.length).toBeGreaterThanOrEqual(8);
    // The already-disambiguated topic: lossless under the fold, yet still given a suffix.
    expect(GOLDEN.some(([, fold, topic, , name]) => fold(topic) === topic && name !== topic)).toBe(
      true,
    );
    expect(GOLDEN.some(([, , , opts]) => opts.sep !== undefined || opts.hashLen !== undefined)).toBe(
      true,
    );
  });

  const vectorLabel = (g: (typeof GOLDEN)[number]): string =>
    `${g[0]}: ${JSON.stringify(g[2])}${Object.keys(g[3]).length === 0 ? '' : ` ${JSON.stringify(g[3])}`}`;

  it('names every vector distinctly, so a failure locates its row', () => {
    expect(new Set(GOLDEN.map(vectorLabel)).size).toBe(GOLDEN.length);
  });

  it.each(GOLDEN.map((g) => [vectorLabel(g), g] as const))(
    'mints %s unchanged',
    (_label, [, fold, topic, opts, expected]) => {
      expect(safeName(asTopic(topic), fold, opts)).toBe(expected);
    },
  );
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
