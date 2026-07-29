import { asHandle, asTopic, MIN_HASH_LEN, type Topic } from '@sharptrick/parley-core';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// Class: a backend legal-charset fold whose two properties are asserted nowhere against the
// backend. Both folds here — topic -> MUC room localpart, identity.handle -> MUC nick — must be
// TOTAL (every legal config value yields a name, or a refusal that names this plugin) and
// INJECTIVE (two distinct inputs never land on one room or one occupant). Neither held:
// bridge-core's topic-name.test.ts re-declares its own copies of these regexes and never imports
// the plugin, so deleting safeName from either fold left the whole package suite green while
// 'Ops'/'ops' shared a room and 'a b'/'a_b' shared a sender; and the nick fold's own 64-character
// truncation rewrote the disambiguating suffix safeName had just appended, so safeName REFUSED
// every handle longer than that — bricking `post` for a config bridge-core accepts. The table
// therefore crosses length with charset (the length axis is what the hostile-content table, all of
// whose payloads are short, cannot reach) and drives the real code paths: roomJid() itself, and the
// nick as it appears on the join presence.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv } from './fake-xmpp.js';

const PASSWORD = 'a-real-secret';
const LEGAL_NICK = /^[A-Za-z0-9.\-_]+$/;
const LEGAL_LOCALPART = /^[a-z0-9.\-_]+$/;
/** RFC 7622 §3.3/§3.4: a localpart and a resourcepart are each capped at 1023 bytes. */
const JID_PART_MAX = 1023;

/** A string of exactly `len` UTF-16 code units, in one charset class. */
const charsets = {
  'ascii-legal': (len: number) => 'a'.repeat(len),
  'contains-space': (len: number) => `a${' '.repeat(len)}a`.slice(0, len),
  'contains-slash': (len: number) => `a${'/'.repeat(len)}a`.slice(0, len),
  'upper-and-dot': (len: number) => `A.${'B'.repeat(len)}`.slice(0, len),
  'non-ascii': (len: number) => 'ä'.repeat(len),
  'astral-emoji': (len: number) => '🚀'.repeat(len).slice(0, len),
} as const;

/** 53 = 64 - 1 - MIN_HASH_LEN: the width the old nick truncation turned into a hard failure. */
const lengths = [1, 2, 10, 52, 53, 54, 63, 64, 65, 200];
const cells = Object.entries(charsets).flatMap(([charset, make]) =>
  lengths.map((len) => ({ charset, len, value: make(len) })),
);

const sha10 = (s: string): string =>
  createHash('sha1').update(s, 'utf8').digest('hex').slice(0, MIN_HASH_LEN);

const foldLocal = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.\-_]/g, '_');
const foldNick = (s: string): string => s.replace(/[^A-Za-z0-9.\-_]/g, '_');

/**
 * Pairs a many-to-one fold collapses. The last of each list is the adversarial input that already
 * LOOKS folded-and-disambiguated: a caller who picks `<fold(x)>-<hash of x>` lands on x's own name
 * unless safeName disambiguates that branch too.
 */
const localCollisions: Array<[string, string]> = [
  ['Ops', 'ops'],
  ['dev ops', 'dev/ops'],
  ['a b', 'a_b'],
  ['team.frontend', 'team_frontend'],
  ['Ops', `${foldLocal('Ops')}-${sha10('Ops')}`],
];
const nickCollisions: Array<[string, string]> = [
  ['a b', 'a_b'],
  ['a/b', 'a_b'],
  ['team.frontend', 'team_frontend'],
  ['agent-A', 'agent_A'],
  ['a b', `${foldNick('a b')}-${sha10('a b')}`],
];

const short = (s: string): string =>
  JSON.stringify(s.length > 24 ? `${s.slice(0, 24)}…(${s.length})` : s);

/** Every distinct input must own its name: report each pair that shares one, not just the first. */
const shared = (inputs: string[], nameOf: (s: string) => string): string[] => {
  const owner = new Map<string, string>();
  const clashes: string[] = [];
  for (const input of inputs) {
    const name = nameOf(input);
    const prior = owner.get(name);
    if (prior !== undefined && prior !== input) {
      clashes.push(`${short(prior)} and ${short(input)} both map to ${short(name)}`);
    }
    owner.set(name, input);
  }
  return clashes;
};

const roomOf = (topic: string): string => priv(new XmppPlugin()).roomJid(asTopic(topic));

/** The nick this plugin actually puts on the wire: the resource of its MUC join presence. */
const nickOnTheWire = async (handle: string): Promise<string> => {
  const fake = new FakeXmpp();
  mockState.client = fake;
  const plugin = new XmppPlugin();
  await plugin.connect({ password: PASSWORD });
  const topic = asTopic('t-fold');
  const room = priv(plugin).roomJid(topic);
  await plugin.post(topic, asHandle(handle), 'benign');
  const to =
    fake.sent
      .filter((s) => s.is('presence') && (s.attrs.to ?? '').startsWith(`${room}/`))
      .at(-1)?.attrs.to ?? '';
  await plugin.disconnect();
  return to.slice(`${room}/`.length);
};

describe('XMPP topic -> MUC room fold is total and injective', () => {
  it.each(cells)('a $len-char $charset topic yields one legal localpart', ({ value }) => {
    const [local, service] = roomOf(value).split('@');
    expect(service).toBe('muc.parley.local');
    expect(local).toMatch(LEGAL_LOCALPART);
    expect((local as string).length).toBeLessThanOrEqual(JID_PART_MAX);
  });

  it('no two topics in the length x charset table share a room', () => {
    expect(shared(cells.map((c) => c.value), roomOf)).toEqual([]);
  });

  it.each(localCollisions)('%j and %j are not the same room', (a, b) => {
    expect(shared([a, b], roomOf)).toEqual([]);
  });

  it('a topic whose localpart cannot fit a JID is refused by name, not by the server', () => {
    expect(() => roomOf('t'.repeat(JID_PART_MAX + 1))).toThrow(
      /parley-xmpp: topic is 1024 characters/,
    );
  });

  it('sampled topics never collide, and a folded-looking twin never steals the original', () => {
    const sampled: string[] = [];
    for (let i = 0; i < 400; i++) {
      const raw = Array.from({ length: 1 + (i % 24) }, () =>
        String.fromCodePoint(0x20 + Math.floor(Math.random() * 0x60)),
      ).join('');
      sampled.push(raw, foldLocal(raw), `${foldLocal(raw)}-${sha10(raw)}`);
    }
    expect(shared(sampled, roomOf)).toEqual([]);
  });
});

describe('XMPP identity.handle -> MUC nick fold is total and injective', () => {
  it.each(cells)('a $len-char $charset handle joins under one legal nick', async ({ value }) => {
    const nick = await nickOnTheWire(value);
    expect(nick).toMatch(LEGAL_NICK);
    expect(nick.length).toBeLessThanOrEqual(JID_PART_MAX);
  });

  it('no two handles in the length x charset table share an occupant nick', async () => {
    const nicks = new Map<string, string>();
    for (const { value } of cells) nicks.set(value, await nickOnTheWire(value));
    expect(shared([...nicks.keys()], (h) => nicks.get(h) as string)).toEqual([]);
  });

  it.each(nickCollisions)('%j and %j are not the same occupant', async (a, b) => {
    const nicks = new Map([
      [a, await nickOnTheWire(a)],
      [b, await nickOnTheWire(b)],
    ]);
    expect(shared([a, b], (h) => nicks.get(h) as string)).toEqual([]);
  });

  it('a handle whose nick cannot fit a JID resource is refused by name, and post says so', async () => {
    const fake = new FakeXmpp();
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: PASSWORD });
    await expect(
      plugin.post(asTopic('t-fold'), asHandle('h'.repeat(JID_PART_MAX + 1)), 'benign'),
    ).rejects.toThrow(/parley-xmpp: identity\.handle is 1024 characters/);
    await plugin.disconnect();
  });
});
