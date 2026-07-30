import { asHandle, asTopic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Class: a self-presence accepted as the answer to a join it is not about. MUC status 110 marks a
// presence as this connection's own, but it does NOT say which nick the join asked for — the answer
// to a superseded join carries 110 for the previous nick, and a nick-locking service answers from a
// nick of its OWN choosing (status 210). Settling a join on 110 alone therefore leaves the plugin
// believing it occupies a room under a nick it does not hold, after which its own reflections fail
// the provenance check in onGroupchat and every post in that room stalls for the full
// POST_TIMEOUT_MS. The table crosses each shape the completing presence can take with what the
// plugin must then believe about its occupant nick.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin } from '../src/index.js';
import { attach, FakeXmpp, priv } from './fake-xmpp.js';

const NS_MUC_USER = 'http://jabber.org/protocol/muc#user';
const NS_SID = 'urn:xmpp:sid:0';
const REQUESTED = 'requested-nick';

const presence = (room: string, nick: string, statuses: string[]): unknown =>
  xml(
    'presence',
    { from: `${room}/${nick}` },
    xml('x', { xmlns: NS_MUC_USER }, ...statuses.map((code) => xml('status', { code }))),
  );

interface Row {
  name: string;
  nick: string;
  statuses: string[];
  settles: boolean;
  /** The occupant nick the plugin must consider itself to hold in that room afterwards. */
  occupant: string;
}

const rows: Row[] = [
  {
    name: 'the requested nick, with 110',
    nick: REQUESTED,
    statuses: ['110'],
    settles: true,
    occupant: REQUESTED,
  },
  {
    name: 'the requested nick, no 110 (the resource is the marker)',
    nick: REQUESTED,
    statuses: [],
    settles: true,
    occupant: REQUESTED,
  },
  {
    name: 'a different nick WITH the service-assigned marker 210',
    nick: 'locked-by-service',
    statuses: ['110', '210'],
    settles: true,
    occupant: 'locked-by-service',
  },
  {
    name: 'a different nick with 110 but no 210 (the answer to a superseded join)',
    nick: 'someone-else',
    statuses: ['110'],
    settles: false,
    occupant: REQUESTED,
  },
  {
    name: 'a stale previous nick with 110',
    nick: 'previous-nick',
    statuses: ['110'],
    settles: false,
    occupant: REQUESTED,
  },
  {
    name: 'a different nick with neither 110 nor 210 (another occupant entirely)',
    nick: 'someone-else',
    statuses: [],
    settles: false,
    occupant: REQUESTED,
  },
];

describe('XMPP settles a join only for a presence it can attribute', () => {
  it.each(rows)('$name', async ({ nick, statuses, settles, occupant }) => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    fake.joinReply = 'silent'; // the presence under test is the only answer this join gets
    const p = attach(plugin, fake);
    p.nick = REQUESTED;
    const room = p.roomJid(asTopic('t-attribution'));

    const outcome = p.joinOnce(room).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    p.onStanza(presence(room, nick, statuses));
    await new Promise((r) => setTimeout(r, 5));

    expect(p.pendingJoins.has(room)).toBe(!settles);
    if (settles) expect(await outcome).toBe('resolved');
    // What the join settling is FOR: the nick this connection will accept its own reflections from.
    expect(p.roomNicks.get(room) ?? p.nick).toBe(occupant);
    await plugin.disconnect();
  });
});

describe('XMPP against a nick-locking service (XEP-0045 status 210)', () => {
  afterEach(() => {
    mockState.client = undefined;
    vi.restoreAllMocks();
  });

  it('adopts the assigned nick, so a post resolves on its reflection not on a timeout', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = new FakeXmpp();
    fake.assignNick = 'locked'; // the service refuses the requested nick and picks this one
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'wanted' });
    const topic = asTopic('t-locked');

    const started = Date.now();
    const id = await plugin.post(topic, asHandle('ctx'), 'hello');
    // Far below POST_TIMEOUT_MS: a reflection that is never correlated shows up as 15 s, not 50 ms.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(String(id)).toMatch(/^arch-/);
    expect(priv(plugin).roomNicks.get(priv(plugin).roomJid(topic))).toBe('locked');

    const read = await plugin.fetchRecent({ topic, limit: 5 });
    expect(read.messages.map((m) => String(m.senderHandle))).toEqual(['locked']);
    await plugin.disconnect();
  });

  it('keys the assigned nick per ROOM, so one room being locked does not break the others', async () => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    fake.joinReply = 'silent';
    const p = attach(plugin, fake);
    p.nick = REQUESTED;
    const locked = p.roomJid(asTopic('t-locked-room'));
    const free = p.roomJid(asTopic('t-free-room'));

    const lockedJoin = p.joinOnce(locked);
    p.onStanza(presence(locked, 'locked', ['110', '210']));
    await lockedJoin;
    const freeJoin = p.joinOnce(free);
    p.onStanza(presence(free, REQUESTED, ['110']));
    await freeJoin;

    // A post in EACH room correlates on its own room's occupant nick.
    for (const [room, nick] of [
      [locked, 'locked'],
      [free, REQUESTED],
    ] as const) {
      let resolved: string | undefined;
      p.pendingPosts.set('o-1', {
        room,
        resolve: (id: unknown) => {
          resolved = String(id);
        },
        reject: () => undefined,
      });
      p.onStanza(
        xml(
          'message',
          { from: `${room}/${nick}`, type: 'groupchat' },
          xml('body', {}, 'x'),
          xml('origin-id', { xmlns: NS_SID, id: 'o-1' }),
          xml('stanza-id', { xmlns: NS_SID, by: room, id: `arch-${nick}` }),
        ),
      );
      expect(resolved).toBe(`arch-${nick}`);
      p.pendingPosts.clear();
    }
    await plugin.disconnect();
  });
});
