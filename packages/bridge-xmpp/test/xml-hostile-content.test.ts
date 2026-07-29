import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';

// Class: a caller-supplied string serialised onto a shared, stateful transport without being
// validated for what that transport can carry. XMPP is one long-lived XML document: a single
// codepoint XML forbids is not a rejected stanza, it is `not-well-formed` and the END of the
// stream — which drops MUC occupancy for EVERY room this connection serves and destroys each
// non-persistent room's whole MAM archive. So the blast radius of one bad byte in one field is
// every OTHER topic's history, and a guard on one field is worth nothing while a sibling field
// reaches the same wire unchecked (the `since` cursor did, and it is `z.string()` straight off the
// parley_fetch_recent tool). The table is therefore the CROSS PRODUCT of every wire-bound string
// this plugin serialises with every codepoint XML 1.0 excludes, plus legal-but-tricky payloads as
// negative controls. Each cell demands the same two things of every field: refuse naming the
// offending codepoint or round-trip cleanly, and either way leave the stream alive and an
// untouched bystander topic still holding its history.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin, type XmppBackendConfig } from '../src/index.js';
import { FakeXmpp, illegalCodepoint } from './fake-xmpp.js';

const BYSTANDER = asTopic('bystander');
const HISTORY = 'unrelated-history';
const PASSWORD = 'a-real-secret';

interface Payload {
  name: string;
  value: string;
  legal: boolean;
}

const c0 = (cp: number): Payload => ({
  name: `C0 control U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
  value: `before${String.fromCharCode(cp)}after`,
  legal: false,
});

const payloads: Payload[] = [
  ...Array.from({ length: 0x20 }, (_, cp) => cp)
    .filter((cp) => cp !== 0x9 && cp !== 0xa && cp !== 0xd)
    .map(c0),
  { name: 'lone high surrogate', value: 'x\uD800y', legal: false },
  { name: 'lone low surrogate', value: 'x\uDC00y', legal: false },
  { name: 'noncharacter U+FFFE', value: `x${String.fromCharCode(0xfffe)}y`, legal: false },
  { name: 'noncharacter U+FFFF', value: `x${String.fromCharCode(0xffff)}y`, legal: false },
  { name: 'tab, newline and carriage return', value: 'a\tb\nc\rd', legal: true },
  { name: 'astral emoji (a valid surrogate PAIR)', value: 'ship it 🚀', legal: true },
  { name: 'markup metacharacters', value: `<body>&amp;</body> "quoted" 'x' ]]>`, legal: true },
  { name: 'RSM metacharacters', value: `<after>&amp;'"/../`, legal: true },
  { name: 'plain ascii', value: 'ordinary', legal: true },
];

/**
 * One wire-bound string, driven all the way to a `send()`: the operation must put the value on
 * this connection's stream if it is not refused first.
 */
interface Field {
  name: string;
  /** Payloads this field cannot even be given (a JID domain has no resource separator). */
  omit?: RegExp;
  drive(fake: FakeXmpp, value: string): Promise<void>;
}

const connected = async (fake: FakeXmpp, cfg: Partial<XmppBackendConfig>): Promise<XmppPlugin> => {
  mockState.client = fake;
  const plugin = new XmppPlugin();
  await plugin.connect({ password: PASSWORD, ...cfg });
  return plugin;
};

const fields: Field[] = [
  {
    name: 'post content',
    drive: async (fake, value) => {
      const plugin = await connected(fake, {});
      await plugin.post(asTopic('hostile'), asHandle('a'), value);
    },
  },
  {
    name: 'catch-up cursor (since)',
    drive: async (fake, value) => {
      const plugin = await connected(fake, {});
      await plugin.fetchRecent({ topic: asTopic('hostile'), since: asCursor(value), limit: 5 });
    },
  },
  {
    name: 'backend_config.nick',
    drive: async (fake, value) => {
      const plugin = await connected(fake, { nick: value });
      await plugin.post(asTopic('hostile'), asHandle('a'), 'benign');
    },
  },
  {
    name: 'backend_config.muc_service',
    omit: /\//,
    drive: async (fake, value) => {
      const plugin = await connected(fake, { muc_service: value });
      await plugin.post(asTopic('hostile'), asHandle('a'), 'benign');
    },
  },
  {
    name: 'backend_config.domain',
    drive: async (fake, value) => {
      const plugin = await connected(fake, { domain: value });
      await plugin.post(asTopic('hostile'), asHandle('a'), 'benign');
    },
  },
  {
    name: 'backend_config.username',
    drive: async (fake, value) => {
      const plugin = await connected(fake, { username: value });
      await plugin.post(asTopic('hostile'), asHandle('a'), 'benign');
    },
  },
  {
    name: 'topic',
    drive: async (fake, value) => {
      const plugin = await connected(fake, {});
      await plugin.post(asTopic(value), asHandle('a'), 'benign');
    },
  },
  {
    name: 'post identity (adopted as the MUC nick)',
    drive: async (fake, value) => {
      const plugin = await connected(fake, {});
      await plugin.post(asTopic('hostile'), asHandle(value), 'benign');
    },
  },
];

const rows = fields.flatMap((field) =>
  payloads
    .filter((p) => field.omit === undefined || !field.omit.test(p.value))
    .map((payload) => ({ field, payload })),
);

describe('XMPP: no caller string reaches the stream carrying a codepoint XML forbids', () => {
  it.each(rows)('$field.name / $payload.name', async ({ field, payload }) => {
    const fake = new FakeXmpp();
    const bystander = await connected(fake, { nick: 'bystander-session' });
    await bystander.post(BYSTANDER, asHandle('b'), HISTORY);

    const outcome = await field.drive(fake, payload.value).then(
      () => 'resolved',
      (e: Error) => e.message,
    );

    // A value XML cannot carry is either refused up front, naming the codepoint, or folded to
    // something legal before it is serialised — never some other failure, and never (below) a
    // stanza that ends the stream.
    const cp = illegalCodepoint(payload.value);
    if (cp === undefined) {
      expect(payload.legal).toBe(true);
    } else {
      const named = `U\\+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      expect(outcome).toMatch(new RegExp(`^resolved$|${named}`));
    }

    // The blast radius that makes this a class: the stream is still up, and a topic that had
    // nothing to do with the hostile value still has the history it had before.
    expect(fake.alive).toBe(true);
    const other = await bystander.fetchRecent({ topic: BYSTANDER, since: asCursor('') });
    expect(other.messages.map((m) => m.content)).toEqual([HISTORY]);
    await bystander.disconnect();
  });
});
