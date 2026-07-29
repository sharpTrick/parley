import { describe, expect, it } from 'vitest';
import { asTopic } from './message.js';
import { safeName } from './topic-name.js';

// Representative copies of each backend's legal-charset fold (byte-for-byte the plugins' own
// module-private regexes). safeName must make each of them injective; asserting against these
// here proves injectivity without exporting the plugins' internals.
const sanitizeToken = (s: string): string => s.replace(/[.*>\s]/g, '_'); // NATS subject
const sanitizeName = (s: string): string => s.replace(/[.*>/\\\s]/g, '_'); // NATS stream
const sanitizeAlias = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_'); // Matrix alias
const sanitizeLocal = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.\-_]/g, '_'); // XMPP JID

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
    expect(out).toMatch(/^team_frontend-[0-9a-f]{10}$/);
  });

  it('is deterministic and idempotent-safe (same raw topic → same name)', () => {
    expect(safeName(asTopic('a b'), sanitizeAlias)).toBe(safeName(asTopic('a b'), sanitizeAlias));
  });

  it('honours custom hashLen / sep options', () => {
    const out = safeName(asTopic('a b'), sanitizeAlias, { hashLen: 4, sep: '.' });
    expect(out).toMatch(/^a_b\.[0-9a-f]{4}$/);
  });
});

// Injectivity is the whole point of safeName, so assert it as a property over a generated corpus
// CLOSED UNDER safeName ITSELF: every name the mapping produces is fed back in as a raw topic.
// Fixed lossy/lossless pairs can never see the collision that matters — a topic literally equal to
// another topic's disambiguated `<sanitized><sep><hash>` output, which an attacker can compute.
describe('safeName injectivity (generated, closed under its own output)', () => {
  const folds: [string, (s: string) => string][] = [
    ['NATS subject', sanitizeToken],
    ['NATS stream', sanitizeName],
    ['Matrix alias', sanitizeAlias],
    ['XMPP localpart', sanitizeLocal],
  ];

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
    const opts = { hashLen: 4, sep: '.' };
    const first = safeName(asTopic('a b'), fold, opts);
    expect(safeName(asTopic(first), fold, opts)).not.toBe(first);
  });
});
