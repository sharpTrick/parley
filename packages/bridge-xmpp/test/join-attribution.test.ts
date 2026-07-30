import { asHandle, asTopic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Class: a presence accepted as the answer to a join it is not about — in EITHER direction. MUC
// status 110 marks a presence as this connection's own, but it does NOT say which nick the join
// asked for: the answer to a superseded join carries 110 for the previous nick, and a nick-locking
// service answers from a nick of its OWN choosing (status 210). Settling a join on 110 alone leaves
// the plugin believing it occupies a room under a nick it does not hold, after which its own
// reflections fail the provenance check in onGroupchat and every post there stalls for the full
// POST_TIMEOUT_MS; FAILING a join on a refusal addressed to some other nick is the same mistake with
// the sign flipped — a superseded join's `forbidden`/`conflict` rejected the innocent successor,
// which startPushLoop rethrows, and dragged the connection's nick back to its random provisional one
// while telling the operator a handle it never asked for was taken. The table therefore crosses the
// nick the presence names with its status set AND with both presence types, pinning what may settle
// a join, what may fail one, and what the plugin must believe about its occupant nick afterwards.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin } from '../src/index.js';
import { attach, errorEl, FakeXmpp, priv } from './fake-xmpp.js';

const NS_MUC_USER = 'http://jabber.org/protocol/muc#user';
const NS_SID = 'urn:xmpp:sid:0';
const REQUESTED = 'requested-nick';

/** `nick === ''` addresses the ROOM itself: a room-level stanza carries no occupant resource. */
const jidOf = (room: string, nick: string): string => (nick === '' ? room : `${room}/${nick}`);

const presence = (room: string, nick: string, statuses: string[]): unknown =>
  xml(
    'presence',
    { from: jidOf(room, nick) },
    xml('x', { xmlns: NS_MUC_USER }, ...statuses.map((code) => xml('status', { code }))),
  );

/** A join refusal. A real service never rewrites a nick on one, so 210 must buy nothing here. */
const refusal = (room: string, nick: string, statuses: string[]): unknown =>
  xml(
    'presence',
    { from: jidOf(room, nick), type: 'error' },
    xml('x', { xmlns: NS_MUC_USER }, ...statuses.map((code) => xml('status', { code }))),
    errorEl('conflict'),
  );

/** `resolved`/`rejected` settle the join; `ignored` leaves it outstanding for its real answer. */
type Answer = 'resolved' | 'rejected' | 'ignored';

interface Row {
  name: string;
  /** The occupant nick the presence names, `''` for a room-level stanza with no resource. */
  nick: string;
  statuses: string[];
  /** What a `<presence>` naming that nick must do to the outstanding join. */
  available: Answer;
  /** What a `<presence type='error'>` naming it must do. */
  error: Answer;
  /** The occupant nick the plugin must hold afterwards, if the available arm accepted it. */
  occupant: string;
}

const NICKS = [
  { label: "the join's own nick", nick: REQUESTED, addressed: true },
  { label: 'a superseded previous nick', nick: 'previous-nick', addressed: false },
  { label: "another occupant's nick", nick: 'someone-else', addressed: false },
  { label: 'no resource at all (room-level)', nick: '', addressed: true },
];
const STATUS_SETS = [
  { label: 'no status', statuses: [] as string[] },
  { label: 'status 110', statuses: ['110'] },
  { label: 'status 110+210', statuses: ['110', '210'] },
];

/**
 * XEP-0045's rule, written once and expanded over the axes: a presence answers a join only when it
 * names the nick that join asked for (or names no occupant at all), except that an AVAILABLE
 * presence may instead carry status 210 to say the service picked the nick itself. `110` marks a
 * presence as this connection's own; it never says which join it answers, and 210 has no meaning on
 * a refusal — the service that refuses an occupant did not admit it under another name.
 */
const rows: Row[] = NICKS.flatMap(({ label, nick, addressed }) =>
  STATUS_SETS.map(({ label: statusLabel, statuses }): Row => {
    const ours = nick === REQUESTED || statuses.includes('110');
    const accepts = ours && (addressed || statuses.includes('210'));
    return {
      name: `${label}, ${statusLabel}`,
      nick,
      statuses,
      available: accepts ? 'resolved' : 'ignored',
      error: addressed ? 'rejected' : 'ignored',
      occupant: accepts && nick !== '' ? nick : REQUESTED,
    };
  }),
);

const arms = [
  { type: 'available' as const, stanza: presence },
  { type: 'error' as const, stanza: refusal },
];
const cells = arms.flatMap((arm) =>
  rows.map((row) => ({ arm, row, expected: row[arm.type] })),
);

describe('XMPP settles a join only for a presence it can attribute', () => {
  it.each(cells)('a $arm.type presence from $row.name is $expected', async ({ arm, row, expected }) => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    fake.joinReply = 'silent'; // the presence under test is the only answer this join gets
    const p = attach(plugin, fake);
    p.nick = REQUESTED;
    const room = p.roomJid(asTopic('t-attribution'));

    let settled: string | undefined;
    void p.joinOnce(room).then(
      () => (settled = 'resolved'),
      (e: Error) => (settled = `rejected: ${e.message}`),
    );
    p.onStanza(arm.stanza(room, row.nick, row.statuses));
    await new Promise((r) => setTimeout(r, 5));

    expect(p.pendingJoins.has(room)).toBe(expected === 'ignored');
    if (expected === 'resolved') expect(settled).toBe('resolved');
    if (expected === 'rejected') expect(settled).toMatch(/^rejected: MUC join error \(conflict\)/);
    // What the join settling is FOR: the nick this connection accepts its own reflections from. A
    // refusal it could not attribute must not move it either.
    expect(p.roomNicks.get(room) ?? p.nick).toBe(
      arm.type === 'available' ? row.occupant : REQUESTED,
    );

    // Negative control: the join's OWN answer, of the same kind, still settles it — so an ignored
    // row is the attribution rule and not a stanza the router failed to parse.
    if (expected === 'ignored') {
      p.onStanza(arm.stanza(room, REQUESTED, ['110']));
      await new Promise((r) => setTimeout(r, 5));
      expect(settled).toMatch(arm.type === 'available' ? /^resolved$/ : /^rejected: MUC join error/);
      expect(p.pendingJoins.has(room)).toBe(false);
    }
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
