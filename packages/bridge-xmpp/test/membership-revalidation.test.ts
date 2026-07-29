import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  ids: string[];
}

type Loss = (b: Bridge) => Promise<void>;

/** How the server would keep ending occupancy, for the routes it announces with a presence. */
type Repeat = { statuses?: string[]; destroy?: boolean };

const losses: Array<{ how: string; lose: Loss; repeat?: Repeat }> = [
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
    repeat: { statuses: ['307'] },
  },
  {
    how: 'we were banned (status 301)',
    lose: async ({ fake, room }) => fake.endOccupancy(room, { statuses: ['301'] }),
    repeat: { statuses: ['301'] },
  },
  {
    how: 'our affiliation changed us out of a members-only room (status 321)',
    lose: async ({ fake, room }) => fake.endOccupancy(room, { statuses: ['321'] }),
    repeat: { statuses: ['321'] },
  },
  {
    how: 'the room became members-only (status 322)',
    lose: async ({ fake, room }) => fake.endOccupancy(room, { statuses: ['322'] }),
    repeat: { statuses: ['322'] },
  },
  {
    how: 'the MUC service is shutting down (status 332)',
    lose: async ({ fake, room }) => fake.endOccupancy(room, { statuses: ['332'] }),
    repeat: { statuses: ['332'] },
  },
  {
    how: 'the room was destroyed',
    lose: async ({ fake, room }) => fake.endOccupancy(room, { destroy: true }),
    repeat: { destroy: true },
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
  const ids: string[] = [];
  await plugin.subscribe(TOPIC, (m: Message) => {
    delivered.push(String(m.content));
    ids.push(String(m.backendMsgId));
  });
  return { plugin, fake, p, room, delivered, ids };
};

const isJoin = (s: FakeXmpp['sent'][number], room: string): boolean =>
  s.is('presence') && (s.attrs.to ?? '').startsWith(`${room}/`);
const joinPresences = (fake: FakeXmpp, room: string): number =>
  fake.sent.filter((s) => isJoin(s, room)).length;
/** Milliseconds between consecutive join presences for `room`, in send order. */
const joinGaps = (fake: FakeXmpp, room: string): number[] => {
  const at = fake.sentAt.filter((_, i) => isJoin(fake.sent[i] as FakeXmpp['sent'][number], room));
  return at.slice(1).map((t, i) => t - (at[i] as number));
};

describe('XMPP re-enters a room after occupancy ends, however it ended', () => {
  it.each(losses)('recovers when $how', async ({ lose }) => {
    const bridge = await build();
    const { plugin, fake, p, room, delivered, ids } = bridge;
    await plugin.post(TOPIC, asHandle('a'), 'before');
    expect(delivered).toEqual(['before']);

    const cachedJoin = p.joined.get(room);
    const joinsBefore = joinPresences(fake, room);
    await lose(bridge);

    // The stale "we are in this room" promise is gone, and a fresh join presence went out.
    await vi.waitFor(() => expect(joinPresences(fake, room)).toBeGreaterThan(joinsBefore), {
      timeout: 3_000,
    });
    expect(p.joined.get(room)).not.toBe(cachedJoin);

    // Recovery is observable through the seam, not just in the cache: posts land again and the
    // subscriber that went deaf is hearing the room again.
    await vi.waitFor(async () => {
      await expect(plugin.post(TOPIC, asHandle('a'), 'after')).resolves.toBeDefined();
    });
    expect(delivered).toContain('after');
    // Re-entry must not re-deliver: a MUC replays room history to a joiner unless the join asks for
    // none, and a replay through the live path re-fires every subscriber and every long-poll waiter.
    expect(ids).toEqual([...new Set(ids)]);
    await plugin.disconnect();
  });

  it('leaves no re-join timer armed after disconnect', async () => {
    const bridge = await build();
    const { plugin, fake, p, room } = bridge;
    await plugin.post(TOPIC, asHandle('a'), 'before');
    fake.endOccupancy(room, { statuses: ['307'] });
    expect(p.rejoins.size).toBe(1);
    await plugin.disconnect();
    expect(p.rejoins.size).toBe(0);
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

// Class: remote-driven recovery with no backoff and no cap. Every row above loses occupancy exactly
// once, which is the one shape that cannot observe a storm: a room that ends occupancy on EVERY
// join (a moderation bot, a members-only toggle, a MUC component shutting down) turned the recovery
// path into an unbounded join-presence and stderr flood — 800 presences and 800 console.error lines
// per second, at a service that in the 332 case is deliberately going away, until the server's own
// rate limiter dropped the stream and @xmpp/reconnect started it again. Because the re-join was
// driven straight off the loss with no timer, the loop did not even yield: nothing on the event
// loop could interrupt it. Each route is replayed here on every successful join, with a bound on
// both the presences sent inside a fixed window and the reports written.

const repeatable = losses.filter((l) => l.repeat !== undefined);
const errorsFor = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  spy.mock.calls.map((c) => String(c[0]));

describe('XMPP bounds its re-entry when a room keeps ending occupancy', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(repeatable)('backs off instead of storming when $how, every time', async ({ repeat }) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bridge = await build();
    const { plugin, fake, p, room } = bridge;
    await plugin.post(TOPIC, asHandle('a'), 'before');
    const joinsBefore = joinPresences(fake, room);

    fake.kickOnJoin = repeat;
    fake.endOccupancy(room, repeat as Repeat);
    await new Promise((r) => setTimeout(r, 1_000));

    const rejoins = joinPresences(fake, room) - joinsBefore;
    expect(rejoins).toBeGreaterThan(0); // it does keep trying
    expect(rejoins).toBeLessThanOrEqual(6); // but a bounded number of times,
    // and never back-to-back: each re-entry waits, so the room is not hammered inside one tick.
    for (const gap of joinGaps(fake, room)) expect(gap).toBeGreaterThanOrEqual(150);
    expect(errorsFor(errors).length).toBeLessThanOrEqual(2 * rejoins + 2);
    expect(p.rejoins.get(room)?.losses ?? 0).toBeGreaterThan(1); // the losses are counted, not lost

    fake.kickOnJoin = undefined;
    await plugin.disconnect();
  }, 15_000);

  it('gives up loudly after a run of losses, and a seam call can still re-enter', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bridge = await build();
    const { plugin, fake, p, room } = bridge;
    await plugin.post(TOPIC, asHandle('a'), 'before');
    const joinsBefore = joinPresences(fake, room);

    fake.kickOnJoin = { statuses: ['332'] };
    fake.endOccupancy(room, { statuses: ['332'] });
    await vi.advanceTimersByTimeAsync(120_000);

    // Six re-entries over the doubling ladder and then it stops, rather than one every 30 s forever.
    const rejoins = joinPresences(fake, room) - joinsBefore;
    expect(rejoins).toBe(6);
    expect(errorsFor(errors).join('\n')).toContain('not re-entering it again');
    expect(p.joined.has(room)).toBe(false);

    // Giving up is not giving up forever: the room is entered again on the next caller-driven call.
    fake.kickOnJoin = undefined;
    const posted = plugin.post(TOPIC, asHandle('a'), 'after');
    await vi.advanceTimersByTimeAsync(10);
    await expect(posted).resolves.toBeDefined();
    expect(joinPresences(fake, room) - joinsBefore).toBeGreaterThan(rejoins);
    await plugin.disconnect();
  });
});
