import { describe, expect, it } from 'vitest';
import { asTopic } from './message.js';
import { safeName } from './topic-name.js';

// Representative copies of each backend's legal-charset fold (byte-for-byte the plugins' own
// module-private regexes). safeName must make each of them injective; asserting against these
// here proves BUG-14/SEC-07 without exporting the plugins' internals.
const sanitizeToken = (s: string): string => s.replace(/[.*>\s]/g, '_'); // NATS subject
const sanitizeName = (s: string): string => s.replace(/[.*>/\\\s]/g, '_'); // NATS stream
const sanitizeAlias = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_'); // Matrix alias
const sanitizeLocal = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.\-_]/g, '_'); // XMPP JID

describe('safeName', () => {
  it('BUG-14 (NATS): distinct topics with a colliding sanitized stream name map to distinct names', () => {
    const a = safeName(asTopic('team.frontend'), sanitizeName);
    const b = safeName(asTopic('team_frontend'), sanitizeName);
    expect(a).not.toBe(b);
    // The `/`-divergence variant the finder surfaced: subject vs stream folds differ but must
    // each stay injective for the `a/b` vs `a_b` pair.
    expect(safeName(asTopic('a/b'), sanitizeName)).not.toBe(safeName(asTopic('a_b'), sanitizeName));
    expect(safeName(asTopic('a.b'), sanitizeToken)).not.toBe(
      safeName(asTopic('a_b'), sanitizeToken),
    );
  });

  it('BUG-14 (Matrix): distinct topics with a colliding alias localpart map to distinct names', () => {
    expect(safeName(asTopic('a b'), sanitizeAlias)).not.toBe(
      safeName(asTopic('a_b'), sanitizeAlias),
    );
  });

  it('BUG-14 (XMPP): case- and separator-variant topics map to distinct JID localparts', () => {
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
