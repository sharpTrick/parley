import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Class: a connection-wide occupant-nick change that leaves a room this connection ALREADY entered
// addressed under the stale nick. The plugin's own reflections in that room then fail the
// provenance check in onGroupchat, so every later post there stalls to POST_TIMEOUT_MS with nothing
// left to re-reconcile it — a permanent, silent loss of a topic. Four different events move the
// nick (a conflict revert, taking identity.handle on the first post, a service rewrite, a
// reconnect), and only one of them was broken, so the table drives EVERY one of them against
// SEVERAL rooms: a single-room case cannot express the divergence at all.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { xml } from '@xmpp/client';
import { XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv } from './fake-xmpp.js';

const NS_MUC = 'http://jabber.org/protocol/muc';
const NS_SID = 'urn:xmpp:sid:0';
const HANDLE = 'ctx-payments';
/** Far below POST_TIMEOUT_MS (15 s): an uncorrelated reflection shows up as the timeout, not as ms. */
const PROMPT_MS = 2_000;

interface Event {
  name: string;
  /** How the rooms under test are entered, before anything moves the nick. */
  enter(plugin: XmppPlugin, topics: Topic[]): Promise<void>;
  /** The nick-moving event itself. */
  fire(plugin: XmppPlugin, fake: FakeXmpp): Promise<void>;
}

const postEach = async (plugin: XmppPlugin, topics: Topic[]): Promise<void> => {
  for (const t of topics) await plugin.post(t, asHandle(HANDLE), 'before');
};

const events: Event[] = [
  {
    name: 'a conflict on a later room reverts to the provisional nick',
    enter: postEach,
    fire: async (plugin, fake) => {
      fake.conflictNicks.add(HANDLE);
      await plugin.post(asTopic('t-onr-conflict'), asHandle(HANDLE), 'elsewhere');
    },
  },
  {
    name: 'the first post takes identity.handle as the nick',
    enter: async (plugin, topics) => {
      for (const t of topics) await plugin.subscribe(t, () => undefined);
    },
    fire: async (plugin) => {
      await plugin.post(asTopic('t-onr-adopt'), asHandle(HANDLE), 'elsewhere');
    },
  },
  {
    name: 'a nick-locking service rewrites the nick in a later room (status 210)',
    enter: postEach,
    fire: async (plugin, fake) => {
      fake.assignNick = 'locked-by-service';
      await plugin.post(asTopic('t-onr-locked'), asHandle(HANDLE), 'elsewhere');
    },
  },
  {
    name: 'a stream reconnect re-joins every room',
    enter: postEach,
    fire: async (plugin, fake) => {
      const before = fake.sent.filter((s) => s.is('presence')).length;
      fake.emit('online'); // consumed by the first-online guard
      fake.emit('online'); // the reconnect
      await vi.waitFor(() =>
        expect(fake.sent.filter((s) => s.is('presence')).length).toBeGreaterThan(before),
      );
    },
  },
];

const rooms = [1, 2, 3];

describe('XMPP keeps every already-entered room addressable when the occupant nick moves', () => {
  afterEach(() => {
    mockState.client = undefined;
    vi.restoreAllMocks();
  });

  it.each(events.flatMap((event) => rooms.map((count) => ({ event, count }))))(
    '$event.name, with $count room(s) entered first',
    async ({ event, count }) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const fake = new FakeXmpp();
      mockState.client = fake;
      const plugin = new XmppPlugin();
      await plugin.connect({ password: 'a-real-secret' }); // nick unset: HANDLE is adopted
      const topics = Array.from({ length: count }, (_v, i) =>
        asTopic(`t-onr-${events.indexOf(event)}-${i}`),
      );

      await event.enter(plugin, topics);
      await event.fire(plugin, fake);

      for (const t of topics) {
        const started = Date.now();
        const outcome = await plugin.post(t, asHandle(HANDLE), 'after').then(
          (id) => String(id),
          (e: Error) => `ERR ${e.message}`,
        );
        expect(`${String(t)} -> ${outcome}`).toMatch(/-> arch-/);
        expect(Date.now() - started).toBeLessThan(PROMPT_MS);
      }
      await plugin.disconnect();
    },
    30_000,
  );
});

// The fixture half of the same class: a stand-in whose state is COARSER than the production state
// it models agrees with the bug by construction. FakeXmpp held one connection-wide `nick`, so it
// could not represent this connection occupying one room as `alice` and another as `bob` — the only
// state in which a stale nick is observable — and every fake-driven case above would have passed
// against the defect a real Prosody stalls on.
describe('the FakeXmpp stand-in models MUC occupancy per room', () => {
  const enter = async (fake: FakeXmpp, room: string, nick: string): Promise<void> => {
    await fake.send(
      xml('presence', { to: `${room}/${nick}` }, xml('x', { xmlns: NS_MUC })),
    );
  };
  const say = async (fake: FakeXmpp, room: string, body: string): Promise<void> => {
    await fake.send(
      xml(
        'message',
        { to: room, type: 'groupchat', id: `o-${body}` },
        xml('body', {}, body),
        xml('origin-id', { xmlns: NS_SID, id: `o-${body}` }),
      ),
    );
  };

  it('reflects and archives each room from the nick that room admitted', async () => {
    const fake = new FakeXmpp();
    const a = 'room-a@muc.parley.local';
    const b = 'room-b@muc.parley.local';
    await enter(fake, a, 'alice');
    await enter(fake, b, 'bob');

    expect([fake.nickIn(a), fake.nickIn(b)]).toEqual(['alice', 'bob']);

    await say(fake, a, 'in-a');
    await say(fake, b, 'in-b');
    expect(fake.archives.get(a)?.map((i) => i.from)).toEqual([`${a}/alice`]);
    expect(fake.archives.get(b)?.map((i) => i.from)).toEqual([`${b}/bob`]);
  });

  it('answers a join from the nick it admitted, not from the last nick used anywhere', async () => {
    const fake = new FakeXmpp();
    const seen: string[] = [];
    fake.on('stanza', (s) => {
      const el = s as { is(n: string): boolean; attrs: Record<string, string> };
      if (el.is('presence')) seen.push(el.attrs.from ?? '');
    });
    await enter(fake, 'room-a@muc.parley.local', 'alice');
    await enter(fake, 'room-b@muc.parley.local', 'bob');

    expect(seen).toEqual(['room-a@muc.parley.local/alice', 'room-b@muc.parley.local/bob']);
  });
});

describe('XMPP tracks the occupant nick it actually holds per room', () => {
  afterEach(() => {
    mockState.client = undefined;
    vi.restoreAllMocks();
  });

  it('pins the nick of every other entered room when a conflict forces the revert', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = new FakeXmpp();
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret' });
    const p = priv(plugin);
    const kept = asTopic('t-onr-kept');
    await plugin.post(kept, asHandle(HANDLE), 'before');
    const provisional = p.provisionalNick;

    fake.conflictNicks.add(HANDLE);
    await plugin.post(asTopic('t-onr-taken'), asHandle(HANDLE), 'elsewhere');

    expect(p.nick).toBe(provisional);
    // The room entered as HANDLE is still occupied as HANDLE — that is who this connection IS there.
    expect(p.roomNicks.get(p.roomJid(kept))).toBe(HANDLE);
    expect(p.roomNicks.get(p.roomJid(asTopic('t-onr-taken')))).toBeUndefined();
    await plugin.disconnect();
  }, 30_000);
});
