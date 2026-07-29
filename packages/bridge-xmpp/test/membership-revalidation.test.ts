import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';

// Class: membership in a room that this connection can lose WITHOUT the stream dropping, cached as
// a resolved promise and therefore never rebuilt. `joined` is an "ensure" cache keyed by room and
// evicted only on rejection, so once occupancy ends by any route the plugin never re-enters: push
// is permanently dead in silence, every post bounces forever, and every blocking fetchRecent burns
// its whole block_ms because no live stanza can wake it. Only a process restart recovers. A
// reconnect is just ONE of the ways occupancy ends — a kick, a ban, an affiliation change, a room
// destroy and a MUC component restart all end it with the stream still up, and the last of those
// arrives only as a bounced post. The table walks every route and demands the same recovery of
// each: the cache entry goes, a fresh join presence goes out, a later post lands, and a subscriber
// hears it again.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv, type XmppPrivate } from './fake-xmpp.js';

const TOPIC = asTopic('t-membership');
const NICK = 'occupant';

interface Bridge {
  plugin: XmppPlugin;
  fake: FakeXmpp;
  p: XmppPrivate;
  room: string;
  delivered: string[];
}

type Loss = (b: Bridge) => Promise<void>;

const losses: Array<{ how: string; lose: Loss }> = [
  {
    how: 'the stream reconnected (occupancy is presence; the library does not resend it)',
    lose: async ({ fake }) => {
      fake.emit('online'); // the initial connect, consumed by the first-online guard
      fake.emit('online'); // the reconnect
    },
  },
  {
    how: 'we were kicked (status 307)',
    lose: async ({ fake, room }) => fake.endOccupancy(room, { statuses: ['307'] }),
  },
  {
    how: 'we were banned (status 301)',
    lose: async ({ fake, room }) => fake.endOccupancy(room, { statuses: ['301'] }),
  },
  {
    how: 'our affiliation changed us out of a members-only room (status 321)',
    lose: async ({ fake, room }) => fake.endOccupancy(room, { statuses: ['321'] }),
  },
  {
    how: 'the MUC service is shutting down (status 332)',
    lose: async ({ fake, room }) => fake.endOccupancy(room, { statuses: ['332'] }),
  },
  {
    how: 'the room was destroyed',
    lose: async ({ fake, room }) => fake.endOccupancy(room, { destroy: true }),
  },
  {
    how: 'the MUC component restarted, and we only learn of it from a bounced post',
    lose: async ({ plugin, fake, room }) => {
      // No presence at all: the server simply forgot us, exactly as a component restart does.
      fake.forgetOccupancySilently(room);
      await expect(plugin.post(TOPIC, asHandle('a'), 'lost')).rejects.toThrow(/not-acceptable/);
    },
  },
];

const build = async (): Promise<Bridge> => {
  const fake = new FakeXmpp();
  fake.enforceOccupancy = true;
  mockState.client = fake;
  const plugin = new XmppPlugin();
  await plugin.connect({ password: 'a-real-secret', nick: NICK });
  const p = priv(plugin);
  const room = p.roomJid(TOPIC);
  const delivered: string[] = [];
  await plugin.subscribe(TOPIC, (m: Message) => {
    delivered.push(String(m.content));
  });
  return { plugin, fake, p, room, delivered };
};

const joinPresences = (fake: FakeXmpp, room: string): number =>
  fake.sent.filter((s) => s.is('presence') && (s.attrs.to ?? '').startsWith(`${room}/`)).length;

describe('XMPP re-enters a room after occupancy ends, however it ended', () => {
  it.each(losses)('recovers when $how', async ({ lose }) => {
    const bridge = await build();
    const { plugin, fake, p, room, delivered } = bridge;
    await plugin.post(TOPIC, asHandle('a'), 'before');
    expect(delivered).toEqual(['before']);

    const cachedJoin = p.joined.get(room);
    const joinsBefore = joinPresences(fake, room);
    await lose(bridge);

    // The stale "we are in this room" promise is gone, and a fresh join presence went out.
    await vi.waitFor(() => expect(joinPresences(fake, room)).toBeGreaterThan(joinsBefore));
    expect(p.joined.get(room)).not.toBe(cachedJoin);

    // Recovery is observable through the seam, not just in the cache: posts land again and the
    // subscriber that went deaf is hearing the room again.
    await vi.waitFor(async () => {
      await expect(plugin.post(TOPIC, asHandle('a'), 'after')).resolves.toBeDefined();
    });
    expect(delivered).toContain('after');
    await plugin.disconnect();
  });

  it('does not treat its own nick change as losing the room', async () => {
    const bridge = await build();
    const { plugin, fake, p, room } = bridge;
    await plugin.post(TOPIC, asHandle('a'), 'before');

    const cachedJoin = p.joined.get(room);
    const joinsBefore = joinPresences(fake, room);
    fake.endOccupancy(room, { statuses: ['303'] });
    await Promise.resolve();

    expect(p.joined.get(room)).toBe(cachedJoin);
    expect(joinPresences(fake, room)).toBe(joinsBefore);
    await plugin.disconnect();
  });
});
