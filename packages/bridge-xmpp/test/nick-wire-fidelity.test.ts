import { asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';

// Class: a `backend_config` string that `assertXmlSafe` admits but the WIRE does not carry
// unchanged. XML 1.0 §3.3.3 attribute-value normalization rewrites #x9/#xA/#xD to a space inside an
// attribute, and every one of these keys becomes part of a JID that this bridge puts in a `to=`.
// `nick` is the one that had no guard: `nick: 'a\tb'` was accepted, the room admitted the connection
// as `a b`, its own self-presence then failed `onPresence`'s attribution check, and EVERY seam call
// died 15 s later on a `MUC join timeout` naming neither the nick nor this plugin — the exact
// failure the adjacent `/` guard says it exists to prevent.
//
// The offline table sweeps the whole C0 range plus the space rather than the three characters that
// happen to be wrong today, and demands one shape of every cell: refused BY NAME before a stream is
// opened, except for the one cell (`nick`, a plain space) that is legitimate and documented. It is
// generated from the codepoints and from JID_SIZED_KEYS, so a key added to that set is graded before
// it has a bug.
//
// The live block is what stops the offline table becoming a hard-coded list nobody re-derives: no
// local parser can grade this, because the normalization happens at the SERVER — `@xmpp/xml`'s own
// Parser hands `a\tb` straight back, so a round-trip through the fixture would agree with the bug.
// It asks the server instead: whatever the config admits into a nick must come back from a real MUC
// as the same string, promptly.
//
// The server is the second rewriter. Its stringprep profiles fold a nick (resourceprep: NFKC,
// map-to-nothing, non-ASCII spaces) and a MUC service host (nameprep: the same, plus case), and the
// room answers from the folded form, which no raw comparison in the bridge matches. The stringprep
// sweep's oracle is written out here rather than imported, so that a codepoint class dropped from
// the guard reddens a row; its live block asks the server what it folds, for each key it sees.

const mockState = vi.hoisted(() => ({ client: undefined as unknown, streams: 0 }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return {
    ...actual,
    client: (opts: Parameters<typeof actual.client>[0]) => {
      mockState.streams++;
      return mockState.client ?? actual.client(opts);
    },
  };
});

import { JID_SIZED_KEYS, validateBackendConfig, XmppPlugin } from '../src/index.js';
import { BASE, canAuth, freshTopic } from './live-xmpp.js';

const VALID: Record<string, unknown> = {
  service: 'xmpp://127.0.0.1:5222',
  domain: 'parley.local',
  muc_service: 'muc.parley.local',
  username: 'parley',
  password: 'a-real-secret',
  nick: 'session-a',
};

/** Every codepoint at or below the space — the band that carries XML's whole special-cased set. */
const LOW_CODEPOINTS = Array.from({ length: 0x21 }, (_, cp) => cp);

/**
 * The one cell a JID part may legitimately carry from this band: a nick with a plain space in it
 * (`'Agent Smith'`) is admitted by every MUC and reflected verbatim. The other three keys are
 * localparts/hostnames, where a space is a different address.
 */
const isLegitimate = (key: string, cp: number): boolean => key === 'nick' && cp === 0x20;

const cells = JID_SIZED_KEYS.flatMap((key) =>
  LOW_CODEPOINTS.map((cp) => ({
    key,
    cp,
    label: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
    value: `a${String.fromCodePoint(cp)}b`,
    accepted: isLegitimate(key, cp),
  })),
);

const connectWith = async (config: Record<string, unknown>): Promise<Error | undefined> => {
  const plugin = new XmppPlugin();
  try {
    await plugin.connect(config);
    await plugin.disconnect();
    return undefined;
  } catch (err) {
    return err as Error;
  }
};

const stub = (): unknown => ({
  jid: { toString: () => 'parley@parley.local/r' },
  start: async () => undefined,
  stop: async () => undefined,
  send: async () => undefined,
  on: () => undefined,
  iqCaller: { request: async () => undefined },
});

describe('XMPP refuses every backend_config value the wire would rewrite in transit', () => {
  it('the sweep covers a key that carries a nick and one that does not', () => {
    expect(JID_SIZED_KEYS).toContain('nick');
    expect(JID_SIZED_KEYS.length).toBeGreaterThan(1);
    expect(cells.filter((c) => c.accepted)).toHaveLength(1);
  });

  it.each(cells)('$key = a$label b', async ({ key, value, accepted }) => {
    mockState.client = stub();
    const before = mockState.streams;
    const err = await connectWith({ ...VALID, [key]: value });
    mockState.client = undefined;

    if (accepted) {
      expect(err, 'a plain space in a nick is legitimate and must stay accepted').toBeUndefined();
      return;
    }
    expect(err?.message ?? '', 'this value was admitted and the wire will change it').toContain(
      `backend_config.${key}`,
    );
    expect(mockState.streams, 'refused only after a stream was opened').toBe(before);
  });
});

/** RFC 3454 B.1, which both profiles map to nothing. */
const B1 = [0xad, 0x34f, 0x1806, 0x180b, 0x180c, 0x180d, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff];
for (let cp = 0xfe00; cp <= 0xfe0f; cp++) B1.push(cp);
/** RFC 3454 C.1.2, which resourceprep prohibits. */
const C12 = [0xa0, 0x1680, 0x202f, 0x205f, 0x3000];
for (let cp = 0x2000; cp <= 0x200b; cp++) C12.push(cp);

const has = (s: string, table: number[]): boolean =>
  Array.from(s).some((ch) => table.includes(ch.codePointAt(0) as number));

/** What the server keeps as written; anything else it folds, and answers from the folded form. */
const KEPT: Record<'nick' | 'muc_service', (s: string) => boolean> = {
  nick: (s) => s === s.normalize('NFKC') && !has(s, B1) && !has(s, C12),
  muc_service: (s) => s === s.normalize('NFKC').toLowerCase() && !has(s, B1),
};

/** Deterministic, so a red row names a value that reproduces. */
const sample = (n: number): number[] => {
  let x = 0x2545f491;
  return Array.from({ length: n }, () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) % 0x10000;
  });
};

const BMP = Array.from({ length: 0x10000 }, (_, cp) => cp).filter(
  (cp) => cp < 0xd800 || cp > 0xdfff,
);
const probes = [
  ...BMP.filter((cp) => {
    const ch = String.fromCodePoint(cp);
    return ch !== ch.normalize('NFKC') || ch !== ch.toLowerCase();
  }).map((cp) => `a${String.fromCodePoint(cp)}b`),
  ...[...B1, ...C12].map((cp) => `a${String.fromCodePoint(cp)}b`),
  // Each of these is stable alone and composes with the letter before it.
  ...Array.from({ length: 0x70 }, (_, i) => `e${String.fromCodePoint(0x300 + i)}x`),
  ...sample(4000)
    .filter((cp) => cp < 0xd800 || cp > 0xdfff)
    .map((cp) => `a${String.fromCodePoint(cp)}b`),
];

const verdict = (key: string, value: string): 'refused' | 'accepted' => {
  try {
    validateBackendConfig({ ...VALID, [key]: value });
    return 'accepted';
  } catch (err) {
    expect((err as Error).message).toContain(`backend_config.${key}`);
    return 'refused';
  }
};

describe('XMPP refuses every backend_config value the server folds before answering', () => {
  it.each(Object.entries(KEPT))('%s', (key, kept) => {
    const folded = probes.filter((v) => !kept(v));
    expect(folded.length, 'the sweep reaches no value the server folds').toBeGreaterThan(1000);
    const admitted = folded.filter((v) => verdict(key, v) === 'accepted');
    expect(admitted.map((v) => JSON.stringify(v))).toEqual([]);
  });

  it.each([
    ['nick', 'Zo\u00eb'],
    ['nick', 'Agent Smith'],
    ['nick', '\u65e5\u672c'],
    ['muc_service', 'm\u00fcc.example'],
    ['muc_service', 'muc.parley.local'],
  ])('%s = %s, which the server keeps, is admitted', (key, value) => {
    expect(KEPT[key as keyof typeof KEPT](value)).toBe(true);
    expect(verdict(key, value)).toBe('accepted');
  });
});

const serverUp = await canAuth(BASE);

/**
 * A nick the config admitted, driven all the way to a real MUC and read back. `post` is the whole
 * round trip — join, reflection, archive — so a nick the room does not agree we hold never returns.
 */
const roundTrip = async (
  config: Record<string, unknown>,
): Promise<{ sender: string; ms: number }> => {
  const plugin = new XmppPlugin();
  const started = Date.now();
  await plugin.connect({ ...BASE, ...config });
  try {
    const topic = freshTopic('t-nickwire');
    await plugin.post(topic, asHandle('caller'), 'hello');
    const { messages } = await plugin.fetchRecent({ topic, limit: 5 });
    return { sender: String(messages.at(-1)?.senderHandle), ms: Date.now() - started };
  } finally {
    await plugin.disconnect();
  }
};

describe.skipIf(!serverUp)('XMPP a nick a real server admits is the nick the config wrote', () => {
  const admitted = cells.filter((c) => c.key === 'nick');

  it.each(admitted)('nick = a$label b', async ({ value, accepted }) => {
    mockState.client = undefined;
    const refused = await connectWith({ ...BASE, nick: value });
    if (!accepted) {
      expect(refused?.message ?? '').toContain('backend_config.nick');
      return;
    }
    expect(refused).toBeUndefined();
    // Well inside the 15 s join timeout the unguarded value burned, so a row that times out is a
    // failure rather than a slow pass.
    const { sender, ms } = await roundTrip({ nick: value });
    expect(sender).toBe(value);
    expect(ms).toBeLessThan(10_000);
  }, 25_000);

  it('a nick this bridge cannot carry is refused rather than joined and abandoned', async () => {
    const topic = asTopic('t-nickwire-guard');
    const plugin = new XmppPlugin();
    const started = Date.now();
    const err = await plugin
      .connect({ ...BASE, nick: 'a\tb' })
      .then(() => plugin.post(topic, asHandle('caller'), 'hello'))
      .then(
        () => undefined,
        (e: Error) => e,
      );
    await plugin.disconnect().catch(() => undefined);

    expect(err?.message ?? '').toContain('backend_config.nick');
    expect(err?.message ?? '').not.toContain('join timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 25_000);
});

/** Spellings a server folds, for every key whose value the server sees. */
const flipCase = (s: string): string => s.toUpperCase();
const fullwidthFirst = (s: string): string =>
  String.fromCodePoint((s.codePointAt(0) as number) - 0x21 + 0xff01) + s.slice(1);
const softHyphen = (s: string): string => `${s.slice(0, 2)}\u00ad${s.slice(2)}`;
const liveFolds = [
  ...(['domain', 'muc_service'] as const).flatMap((key) =>
    [flipCase, fullwidthFirst, softHyphen].map((fold) => ({
      key,
      value: fold(String(BASE[key])),
    })),
  ),
  ...['\uff21lice', 'e\u0301x', 'nb\u00a0sp', 'zw\u200bj', 'og\u1680m', '\ufb01x', 'Mixed Case'].map(
    (value) => ({ key: 'nick' as const, value }),
  ),
];

describe.skipIf(!serverUp)('XMPP a value the server would fold is refused, or works', () => {
  it.each(liveFolds)('$key = $value', async ({ key, value }) => {
    const config = { nick: 'wire', [key]: value };
    const refused = await connectWith({ ...BASE, ...config });
    if (refused !== undefined) {
      expect(refused.message).toContain(`backend_config.${key}`);
      return;
    }
    const { sender, ms } = await roundTrip(config);
    expect(sender).toBe(config.nick);
    expect(ms).toBeLessThan(10_000);
  }, 25_000);
});
