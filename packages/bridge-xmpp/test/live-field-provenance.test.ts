import { asTopic, type Message } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { describe, expect, it, vi } from 'vitest';

// Class: a Message field the LIVE path fills from XML any co-occupant of the room can write.
// Inbound is untrusted (CLAUDE.md; DESIGN §14) and a MUC reflects an occupant's own XEP-0203
// `<delay>` and XEP-0359 `<stanza-id>` children verbatim, so a field read off the reflection
// without checking WHO attested it is attacker-chosen by the time it reaches agent context. The
// catch-up path reads the server-built `<forwarded>` envelope instead, so every row drives ONE
// stanza through both paths: a forged value that moves only the live path is also the divergence
// the README's "live and catch-up admit the same thing" forbids. `timestamp` assertions elsewhere
// only check `Date.parse` is not NaN, which a forged stamp satisfies.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv } from './fake-xmpp.js';

const NS_DELAY = 'urn:xmpp:delay';
const NS_SID = 'urn:xmpp:sid:0';
/** A stamp no honest clock in this run can produce, so "the forged value got through" is decidable. */
const FORGED_STAMP = '2001-01-01T00:00:00.000Z';

interface Row {
  name: string;
  /** What the occupant put on its own stanza; the room reflects it unchanged. */
  injected(room: string): unknown[];
  /** The stamp the SERVER recorded for the row, when the injected delay is one it is entitled to add. */
  attested?: string;
}

const rows: Row[] = [
  {
    name: 'a delay stamped by another occupant is refused',
    injected: () => [
      xml('delay', { xmlns: NS_DELAY, from: 'attacker@evil.example', stamp: FORGED_STAMP }),
    ],
  },
  {
    name: 'a delay stamped by an occupant JID INSIDE this room is refused',
    injected: (room) => [
      xml('delay', { xmlns: NS_DELAY, from: `${room}/attacker`, stamp: FORGED_STAMP }),
    ],
  },
  {
    name: 'a delay the room itself added is accepted',
    injected: (room) => [xml('delay', { xmlns: NS_DELAY, from: room, stamp: FORGED_STAMP })],
    attested: FORGED_STAMP,
  },
  {
    name: 'a delay with no from at all is accepted — only the room can add one',
    injected: () => [xml('delay', { xmlns: NS_DELAY, stamp: FORGED_STAMP })],
    attested: FORGED_STAMP,
  },
  {
    name: 'a stanza-id stamped by another room is not the archive position',
    injected: () => [xml('stanza-id', { xmlns: NS_SID, by: 'other@muc.parley.local', id: 'forged' })],
  },
  {
    name: 'a stanza-id stamped by an occupant JID inside this room is not the archive position',
    injected: (room) => [xml('stanza-id', { xmlns: NS_SID, by: `${room}/attacker`, id: 'forged' })],
  },
];

/** Whether `iso` is a stamp this run could honestly have produced. */
const isRecent = (iso: string): boolean => Math.abs(Date.now() - Date.parse(iso)) < 60_000;

describe('XMPP live push takes no Message field from an occupant that is not entitled to it', () => {
  it.each(rows)('$name', async (row) => {
    const fake = new FakeXmpp();
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'reader' });
    const topic = asTopic('muc-provenance');
    const room = priv(plugin).roomJid(topic);
    const live: Message[] = [];
    await plugin.subscribe(topic, (m) => live.push(m));

    const item = fake.deliverItem(room, {
      body: 'i am from the past',
      sender: 'attacker',
      ...(row.attested === undefined ? {} : { stamp: row.attested }),
      injected: row.injected(room),
    });
    const fetched = (await plugin.fetchRecent({ topic, limit: 10 })).messages;

    const both = [live[0], fetched[0]];
    expect(both.map((m) => String(m?.backendMsgId))).toEqual([item.archId, item.archId]);
    expect(both.map((m) => String(m?.cursor))).toEqual([item.archId, item.archId]);
    for (const m of both) {
      const stamp = String(m?.timestamp);
      if (row.attested === undefined) {
        expect(stamp).not.toBe(FORGED_STAMP);
        expect(isRecent(stamp)).toBe(true);
      } else {
        expect(stamp).toBe(row.attested);
      }
    }
    // Whatever each path decided, they decided it the same way: one refusing and the other not
    // would report two different times for one backendMsgId.
    const [liveAt, fetchedAt] = both.map((m) => Date.parse(String(m?.timestamp)));
    expect(Math.abs((liveAt as number) - (fetchedAt as number))).toBeLessThan(5_000);

    await plugin.disconnect();
    mockState.client = undefined;
  });
});
