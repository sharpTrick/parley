import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
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
//
// The table is a generator over the PROVENANCE ATTRIBUTE, not over a list of hostile children: for
// every attested child the live path reads, the same attributions are graded — an occupant of this
// room, a stranger, the MUC service component, the attribute ABSENT, and the room itself (which the
// server strips, so it never reaches the plugin at all). Absent is the row this suite previously
// asserted the opposite of ('a delay with no from at all is accepted — only the room can add one'),
// which is what let a co-occupant choose `timestamp`: XEP-0203 makes `from` a SHOULD, so an omitted
// one attests nothing, and a live Prosody does reflect an occupant's un-attributed `<delay>`
// verbatim. The room-attested arm is graded separately, on a value the ROOM adds — see the gated
// real-MUC case at the bottom, which asks the server rather than the fixture what it forwards.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return {
    ...actual,
    client: (opts: Parameters<typeof actual.client>[0]) => mockState.client ?? actual.client(opts),
  };
});

import { XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv } from './fake-xmpp.js';
import { BASE, canAuth, freshTopic, SECOND_ACCOUNT } from './live-xmpp.js';

const NS_DELAY = 'urn:xmpp:delay';
const NS_SID = 'urn:xmpp:sid:0';
const NS_MUC = 'http://jabber.org/protocol/muc';
/** A stamp no honest clock in this run can produce, so "the forged value got through" is decidable. */
const FORGED_STAMP = '2001-01-01T00:00:00.000Z';
const FORGED_ARCHIVE_ID = 'forged-archive-position';

/**
 * How an occupant can fill in the provenance attribute of a child it writes itself. Every one of
 * these is unattested by the time it reaches the plugin: the room strips the only value that would
 * name itself, and no other value names the room.
 */
interface Attribution {
  name: string;
  /** The attribute value, or `undefined` for the attribute omitted entirely. */
  value(room: string): string | undefined;
}
const attributions: Attribution[] = [
  { name: 'another occupant of this room', value: (room) => `${room}/attacker` },
  { name: 'a stranger', value: () => 'attacker@evil.example' },
  // Prosody reflects this one VERBATIM: the MUC component is a different JID from the room, so a
  // check on the domain rather than on the full room JID would admit it.
  { name: 'the MUC service component', value: (room) => room.slice(room.indexOf('@') + 1) },
  { name: 'nobody (the attribute is absent)', value: () => undefined },
  // The server strips a child an occupant attributed to the room, so the plugin sees no child at
  // all — the forged value must still be absent from the Message either way.
  { name: 'the room itself (stripped by the MUC)', value: (room) => room },
];

/** One child of a live reflection whose content the plugin reads into a Message field. */
interface AttestedChild {
  name: string;
  /** The attribute XEP-0203/XEP-0359 puts the attesting entity in. */
  attribute: string;
  build(attribution: string | undefined): unknown;
  /** What an honoured forgery would move: `stamp` becomes `timestamp`, `id` becomes the cursor. */
  field: 'timestamp' | 'cursor';
}
const children: AttestedChild[] = [
  {
    name: '<delay>',
    attribute: 'from',
    field: 'timestamp',
    build: (from) =>
      xml('delay', { xmlns: NS_DELAY, ...(from === undefined ? {} : { from }), stamp: FORGED_STAMP }),
  },
  {
    name: '<stanza-id>',
    attribute: 'by',
    field: 'cursor',
    build: (by) =>
      xml('stanza-id', { xmlns: NS_SID, ...(by === undefined ? {} : { by }), id: FORGED_ARCHIVE_ID }),
  },
];

const cells = children.flatMap((child) =>
  attributions.map((attribution) => ({ child, attribution })),
);

// Class: a child an occupant can attach that changes which BRANCH of the dispatcher the whole
// message takes. The table above only grades whether a forged VALUE is honoured, so a child that
// makes the message vanish before it is ever parsed satisfies every row of it — and vanishing is
// worse than a forged field: the message is in the archive, so catch-up returns it while the live
// path and every parked long-poll never see it, which is exactly the divergence the README forbids.
// The generator is over the children the dispatcher and the stanza parser BRANCH on, whatever they
// are for, because it is the branch and not the child that is the hazard.
const readChildren: Array<{ name: string; build(room: string): unknown }> = [
  ...children.map((c) => ({
    name: c.name,
    build: (room: string) => c.build(`${room}/attacker`),
  })),
  {
    name: "<result xmlns='urn:xmpp:mam:2'> (the MAM-collector arm)",
    build: () => xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: 'q', id: FORGED_ARCHIVE_ID }),
  },
  {
    name: "<forwarded xmlns='urn:xmpp:forward:0'> (what archivedItem unwraps)",
    build: (room) =>
      xml(
        'forwarded',
        { xmlns: 'urn:xmpp:forward:0' },
        xml('message', { from: `${room}/victim` }, xml('body', {}, 'forged inner body')),
      ),
  },
  {
    name: "<origin-id xmlns='urn:xmpp:sid:0'> (the post correlator)",
    build: () => xml('origin-id', { xmlns: NS_SID, id: 'o-not-ours' }),
  },
  {
    name: '<error> (the bounce arm)',
    build: () =>
      xml(
        'error',
        { type: 'cancel' },
        xml('not-acceptable', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }),
      ),
  },
];

describe('XMPP live push delivers a message whatever child an occupant hangs off it', () => {
  it.each(readChildren)('a message carrying $name is delivered and wakes a parked long-poll', async ({ build }) => {
    const fake = new FakeXmpp();
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'reader' });
    const topic = asTopic('muc-dispatch');
    const room = priv(plugin).roomJid(topic);
    const live: Message[] = [];
    await plugin.subscribe(topic, (m) => live.push(m));

    const waiter = priv(plugin).armWaiter(room);
    let woke: string | undefined;
    void waiter.park(10_000).then((r) => (woke = r));

    const item = fake.deliverItem(room, {
      body: 'still a message',
      sender: 'attacker',
      injected: [build(room)],
    });
    await new Promise((r) => setTimeout(r, 5));
    waiter.cancel();

    expect({
      delivered: live.map((m) => m.content),
      id: String(live[0]?.backendMsgId),
      woke,
    }).toEqual({ delivered: ['still a message'], id: item.archId, woke: 'message' });

    await plugin.disconnect();
    mockState.client = undefined;
  });
});

/** Whether `iso` is a stamp this run could honestly have produced. */
const isRecent = (iso: string): boolean => Math.abs(Date.now() - Date.parse(iso)) < 60_000;

describe('XMPP live push takes no Message field from an occupant that is not entitled to it', () => {
  it.each(cells)(
    '$child.name attributed by $child.attribute to $attribution.name',
    async ({ child, attribution }) => {
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
        injected: [child.build(attribution.value(room))],
      });
      const fetched = (await plugin.fetchRecent({ topic, limit: 10 })).messages;

      const both = [live[0], fetched[0]];
      // The archive position is the room's own stanza-id whatever an occupant claims: an honoured
      // forgery here is a backendMsgId and a cursor core would store for someone else's position.
      expect(both.map((m) => String(m?.backendMsgId))).toEqual([item.archId, item.archId]);
      expect(both.map((m) => String(m?.cursor))).toEqual([item.archId, item.archId]);
      for (const m of both) {
        const stamp = String(m?.timestamp);
        expect(stamp).not.toBe(FORGED_STAMP);
        expect(isRecent(stamp)).toBe(true);
      }
      // Whatever each path decided, they decided it the same way: one refusing and the other not
      // would report two different times for one backendMsgId.
      const [liveAt, fetchedAt] = both.map((m) => Date.parse(String(m?.timestamp)));
      expect(Math.abs((liveAt as number) - (fetchedAt as number))).toBeLessThan(5_000);

      await plugin.disconnect();
      mockState.client = undefined;
    },
  );
});

// The other half of the same guard: a stamp the ROOM itself attested is honoured, and is the same
// value catch-up reports. Without this the table above is satisfied by a plugin that simply drops
// every `<delay>`, which would make the two paths disagree for every delayed delivery.
describe('XMPP live push honours the stamp the room itself attested', () => {
  it('the delay the MUC added is the timestamp on both paths', async () => {
    const fake = new FakeXmpp();
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'reader' });
    const topic = asTopic('muc-provenance-attested');
    const room = priv(plugin).roomJid(topic);
    const live: Message[] = [];
    await plugin.subscribe(topic, (m) => live.push(m));

    fake.deliverItem(room, { body: 'delayed by the room', sender: 'someone', stamp: FORGED_STAMP });
    const fetched = (await plugin.fetchRecent({ topic, limit: 10 })).messages;

    expect([live[0], fetched[0]].map((m) => String(m?.timestamp))).toEqual([
      FORGED_STAMP,
      FORGED_STAMP,
    ]);

    await plugin.disconnect();
    mockState.client = undefined;
  });
});

// Class: a provenance guard graded only against a fake that mirrors the plugin's own model. FakeXmpp
// reflects `shape.injected` verbatim BY CONSTRUCTION, so no fake-driven case in this package can
// discover that "a MUC strips what an occupant is not entitled to add" is false — which is how the
// absent-`from` row above came to assert the attacker's outcome as correct. This case asks a real
// MUC instead: a second account joins the room, injects each hostile child, and the plugin's
// admission set is graded as a SUBSET of what the server actually forwards.

const serverUp = await canAuth(BASE);
const secondAccount = serverUp && (await canAuth(SECOND_ACCOUNT));

/** A raw second connection, so the hostile stanza is written by an occupant and not by the plugin. */
const occupant = async (room: string, nick: string): Promise<{
  send(el: unknown): Promise<unknown>;
  stop(): Promise<unknown>;
}> => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  const c = actual.client({
    service: SECOND_ACCOUNT.service,
    domain: SECOND_ACCOUNT.domain,
    username: SECOND_ACCOUNT.username,
    password: SECOND_ACCOUNT.password,
  }) as unknown as {
    send(el: unknown): Promise<unknown>;
    start(): Promise<unknown>;
    stop(): Promise<unknown>;
    on(e: string, cb: () => void): void;
  };
  c.on('error', () => undefined);
  await c.start();
  await c.send(
    xml('presence', { to: `${room}/${nick}` }, xml('x', { xmlns: NS_MUC }, xml('history', { maxstanzas: '0' }))),
  );
  return c;
};

describe.skipIf(!secondAccount)('XMPP live provenance against a real MUC', () => {
  it('a co-occupant cannot move timestamp or cursor with any child it can write', async () => {
    mockState.client = undefined;
    const plugin = new XmppPlugin();
    await plugin.connect({ ...BASE, nick: 'provenance-reader' });
    const topic = freshTopic('provenance');
    const live: Message[] = [];
    let attacker: Awaited<ReturnType<typeof occupant>> | undefined;
    try {
      await plugin.subscribe(topic, (m) => live.push(m));
      // The room is created LOCKED, so unlock it via the plugin's own join before a second
      // account can enter: posting is what drives configureRoom to completion.
      await plugin.post(topic, asHandle('seed'), 'seed');
      const room = priv(plugin).roomJid(topic);
      attacker = await occupant(room, 'attacker');

      const bodies: string[] = [];
      for (const child of children) {
        for (const attribution of attributions) {
          const body = `hostile-${child.field}-${attribution.name}`;
          bodies.push(body);
          await attacker.send(
            xml(
              'message',
              { to: room, type: 'groupchat' },
              xml('body', {}, body),
              child.build(attribution.value(room)) as never,
            ),
          );
        }
      }
      // …and the dispatcher-branch table through the same real MUC, so that "the server would never
      // forward that child anyway" is the server's answer here rather than this suite's assumption.
      for (const [i, child] of readChildren.entries()) {
        const body = `dispatch-${i}`;
        bodies.push(body);
        await attacker.send(
          xml(
            'message',
            { to: room, type: 'groupchat' },
            xml('body', {}, body),
            child.build(room) as never,
          ),
        );
      }

      await vi.waitFor(
        () => expect(live.filter((m) => bodies.includes(m.content)).length).toBe(bodies.length),
        { timeout: 15_000, interval: 200 },
      );

      const hostile = live.filter((m) => bodies.includes(m.content));
      // Whatever the server chose to forward, nothing an occupant wrote became a Message field.
      expect(hostile.map((m) => String(m.timestamp)).filter((t) => !isRecent(t))).toEqual([]);
      expect(hostile.map((m) => String(m.cursor)).filter((c) => c === FORGED_ARCHIVE_ID)).toEqual([]);

      // …and the live values are the SAME values catch-up reports for those ids.
      const { messages } = await plugin.fetchRecent({ topic, limit: 50 });
      const archived = new Map(messages.map((m) => [String(m.backendMsgId), m]));
      for (const m of hostile) {
        const mam = archived.get(String(m.backendMsgId));
        expect(mam?.content).toBe(m.content);
        expect(
          Math.abs(Date.parse(String(m.timestamp)) - Date.parse(String(mam?.timestamp))),
        ).toBeLessThan(5_000);
      }
    } finally {
      await attacker?.stop().catch(() => undefined);
      await plugin.disconnect();
    }
  }, 60_000);
});
