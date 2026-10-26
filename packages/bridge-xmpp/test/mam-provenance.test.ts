import { asTopic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { describe, expect, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { attach, type ArchiveItem, FakeXmpp, priv } from './fake-xmpp.js';

// XMPP MAM result provenance. `onMamResult` must accept a streamed
// `<result xmlns='urn:xmpp:mam:2'>` item ONLY when the outer message stanza's `from` is the queried
// room's BARE JID — the archive is served by the room, and a service stanza carries no occupant
// resource (RFC 6120 §8.3). A bare JID check alone admits `room@svc/eve`, and a MUC reflects an
// occupant's own unknown children verbatim, so a co-occupant that has seen a live `queryid` could
// otherwise write rows (and their archive ids, which are this backend's cursors) into a catch-up
// page. And the query correlator (`queryid`) must be a crypto UUID, not a Math.random() token.
// These are pure functions of the parsed stanza / query setup, so they run without a live server.

const NS_MAM = 'urn:xmpp:mam:2';
const NS_FORWARD = 'urn:xmpp:forward:0';
const NS_DELAY = 'urn:xmpp:delay';

type MamItem = ArchiveItem;

/**
 * A forwarded MAM `<result>` wrapped in an outer `message` stanza, exactly as a server (or an
 * off-path attacker) would push it into the session. `outerFrom` is the stanza-level `from`
 * whose bare JID provenance is (or is not) verified.
 */
const mamResultMessage = (opts: {
  outerFrom: string;
  queryid: string;
  archId: string;
  innerFrom: string;
  body: string;
  stamp?: string;
}): unknown =>
  xml(
    'message',
    { from: opts.outerFrom },
    xml(
      'result',
      { xmlns: NS_MAM, queryid: opts.queryid, id: opts.archId },
      xml(
        'forwarded',
        { xmlns: NS_FORWARD },
        ...(opts.stamp !== undefined
          ? [xml('delay', { xmlns: NS_DELAY, stamp: opts.stamp })]
          : []),
        xml('message', { from: opts.innerFrom }, xml('body', {}, opts.body)),
      ),
    ),
  );

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('XMPP MAM result provenance', () => {
  const ROOM = 'myroom@muc.parley.local';
  const QUERYID = 'live-query-id-abc123';

  // The generator is over WHO the outer `from` names, not over a list of hostile stanzas: exactly
  // one entity serves a room's archive, so every other naming — including one inside the room the
  // query targeted — is a `<result>` the collector must not take. A row that is merely a different
  // BARE jid grades only half the check; the co-occupant row is what the resource half is for.
  const senders: Array<{ name: string; from(room: string): string; collected: boolean }> = [
    { name: 'the queried room itself', from: (room) => room, collected: true },
    { name: 'a co-occupant of the queried room', from: (room) => `${room}/eve`, collected: false },
    { name: 'this connection own occupant jid', from: (room) => `${room}/reader`, collected: false },
    { name: 'a stranger', from: () => 'evil@example.com', collected: false },
    { name: 'a stranger with a resource', from: () => 'evil@example.com/attacker', collected: false },
    { name: 'a different room', from: () => 'other@muc.parley.local', collected: false },
    {
      name: 'the MUC service component',
      from: (room) => room.slice(room.indexOf('@') + 1),
      collected: false,
    },
    { name: 'nobody (from absent)', from: () => '', collected: false },
  ];

  it.each(senders)(
    'a <result> whose outer from is $name is collected: $collected',
    ({ from, collected }) => {
      const plugin = new XmppPlugin();
      const items: MamItem[] = [];
      // Register a live collector bound to ROOM, as mamQuery would.
      priv(plugin).mamCollectors.set(QUERYID, { room: ROOM, items });

      priv(plugin).onStanza(
        mamResultMessage({
          outerFrom: from(ROOM),
          queryid: QUERYID, // the attacker rows know or guessed the live queryid
          archId: 'ARCH-0001',
          innerFrom: `${ROOM}/alice`,
          body: 'an archived message',
          stamp: '2026-07-06T00:00:00Z',
        }),
      );

      expect(items.map((i) => i.archId)).toEqual(collected ? ['ARCH-0001'] : []);
      if (collected) expect(items[0]?.body).toBe('an archived message');
    },
  );

  it('proves each drop is the provenance check, not a parse failure: the SAME stanza IS collected when the collector is bound to that sender', () => {
    // Negative control / mutation guard. Bind the collector to each rejected sender's own BARE jid
    // and re-feed the stanza the table rejected. A row that still refuses is refusing for a reason
    // the table does not name — a malformed stanza, a queryid mismatch — and the green above would
    // be worthless. The co-occupant rows stay refused even here, because a resource is never the
    // archive's server, so they are asserted separately.
    for (const sender of senders) {
      const plugin = new XmppPlugin();
      const items: MamItem[] = [];
      const from = sender.from(ROOM);
      const bare = from.includes('/') ? from.slice(0, from.indexOf('/')) : from;
      priv(plugin).mamCollectors.set(QUERYID, { room: bare, items });

      priv(plugin).onStanza(
        mamResultMessage({
          outerFrom: from,
          queryid: QUERYID,
          archId: 'ARCH-0001',
          innerFrom: `${ROOM}/alice`,
          body: 'an archived message',
          stamp: '2026-07-06T00:00:00Z',
        }),
      );

      expect({ sender: sender.name, ids: items.map((i) => i.archId) }).toEqual({
        sender: sender.name,
        ids: from.includes('/') ? [] : ['ARCH-0001'],
      });
    }
  });

  // The dispatch axis: WHICH arm a stanza carrying a `<result>` is handled by. A MUC reflects an
  // occupant's own unknown children verbatim (verified against a live Prosody: the room forwards
  // `<result xmlns='urn:xmpp:mam:2'>` on a co-occupant's groupchat message untouched), and it also
  // sends room-level `type='groupchat'` traffic from the room's own BARE jid — which passes the
  // provenance check above. So the two arms must be disjoint by the stanza's TYPE and not by which
  // child it happens to carry: delivered content is delivered, and only what is not delivered
  // content can be an archive envelope. Prosody streams a genuine result on a message with no type
  // attribute at all, so the row for that carrier is the one that must still collect.
  const carriers: Array<{ type?: string; collected: boolean }> = [
    { type: undefined, collected: true },
    { type: 'normal', collected: true },
    { type: 'chat', collected: true },
    { type: 'headline', collected: true },
    { type: 'groupchat', collected: false },
    { type: 'error', collected: false },
  ];

  it.each(carriers)(
    'a <result> from the room itself on a $type carrier is collected: $collected',
    ({ type, collected }) => {
      const plugin = new XmppPlugin();
      const items: MamItem[] = [];
      priv(plugin).mamCollectors.set(QUERYID, { room: ROOM, items });

      priv(plugin).onStanza(
        xml(
          'message',
          { from: ROOM, ...(type === undefined ? {} : { type }) },
          xml(
            'result',
            { xmlns: NS_MAM, queryid: QUERYID, id: 'ARCH-0001' },
            xml(
              'forwarded',
              { xmlns: NS_FORWARD },
              xml('message', { from: `${ROOM}/alice` }, xml('body', {}, 'an archived message')),
            ),
          ),
        ),
      );

      expect(items.map((i) => i.archId)).toEqual(collected ? ['ARCH-0001'] : []);
    },
  );

  // …and the other side of that disjointness: the message the groupchat row refuses to collect is
  // still DELIVERED. Without this the guard above is satisfiable by a dispatcher that drops such a
  // message entirely — the live path silently losing something catch-up still returns.
  it('a groupchat message carrying a stray <result> is not taken by the MAM arm', () => {
    const plugin = new XmppPlugin();
    const items: MamItem[] = [];
    priv(plugin).mamCollectors.set(QUERYID, { room: ROOM, items });
    const delivered: string[] = [];
    priv(plugin).subscriptions.set(ROOM, {
      topic: asTopic('mam-provenance'),
      handlers: [(m) => void delivered.push((m as { content: string }).content)],
    });

    priv(plugin).onStanza(
      xml(
        'message',
        { from: `${ROOM}/eve`, type: 'groupchat' },
        xml('body', {}, 'hostile'),
        xml('result', { xmlns: NS_MAM, queryid: QUERYID, id: 'FORGED-ARCH-9999' }),
        xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: ROOM, id: 'arch-real' }),
      ),
    );

    expect({ collected: items.map((i) => i.archId), delivered }).toEqual({
      collected: [],
      delivered: ['hostile'],
    });
  });

  it('generates the MAM queryid with crypto.randomUUID(), not Math.random()', async () => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    attach(plugin, fake);

    const res = await priv(plugin).mamQuery(asTopic('room1'), { max: 200 });
    expect(res.complete).toBe(true);

    const capturedQueryid = fake.sentIqs[0]?.getChild('query', NS_MAM)?.attrs.queryid;
    expect(capturedQueryid).toBeDefined();
    // The Math.random() token was `q-...`; a crypto UUID matches the canonical UUID shape.
    expect(capturedQueryid).toMatch(UUID_RE);
    expect(capturedQueryid?.startsWith('q-')).toBe(false);

    // And the collector was registered under that UUID for the duration of the query
    // (deleted again in mamQuery's finally, so the map is empty once it resolves).
    expect(priv(plugin).mamCollectors.size).toBe(0);
  });
});
