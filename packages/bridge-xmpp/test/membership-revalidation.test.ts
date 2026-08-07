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

import { REJOIN_MAX_WAIT_MS, XmppPlugin } from '../src/index.js';
import { attach, FakeXmpp, priv, type XmppPrivate } from './fake-xmpp.js';

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

/**
 * Bounce conditions that mean "you are not an occupant of this room". The plugin's own table is the
 * thing under test, so this list is written out rather than imported: dropping an entry there makes
 * that row stop recovering, and adding one makes the negative control below re-enter a room it must
 * not. Real services disagree on which they send — Prosody bounces `item-not-found` for a room
 * destroyed while we held it joined — so a table with rows for one entry is a table one server-side
 * upgrade away from a silently dead topic.
 */
const OCCUPANCY_BOUNCES = ['not-acceptable', 'gone', 'item-not-found', 'recipient-unavailable'];
/** A bounce that does NOT mean that: no voice in a moderated room. Occupancy is intact. */
const VOICE_BOUNCE = 'forbidden';

const losses: Array<{ how: string; lose: Loss; repeat?: Repeat }> = [
  {
    how: 'the stream reconnected (occupancy is presence; the library does not resend it)',
    lose: async ({ fake }) => {
      fake.emit('online'); // the initial connect, consumed by the first-online guard
      fake.emit('online'); // the reconnect
    },
  },
  // One row per DETECTION branch, not per status code: kick, ban, affiliation, members-only and
  // shutdown all reach onPresence through the same `unavailable` + self + no-303 test, and the code
  // itself is read only by the reason map, which "reports why occupancy ended" grades one row per
  // entry. Keep the per-code rows there rather than here, so that each costs a stanza instead of a
  // connect/join/post/re-join cycle it cannot independently fail.
  {
    how: 'the server announced the end with our own unavailable presence',
    lose: async ({ fake, room }) => fake.endOccupancy(room, { statuses: ['307'] }),
    repeat: { statuses: ['307'] },
  },
  {
    how: 'the room was destroyed',
    lose: async ({ fake, room }) => fake.endOccupancy(room, { destroy: true }),
    repeat: { destroy: true },
  },
  ...OCCUPANCY_BOUNCES.map((condition) => ({
    how: `the MUC forgot us silently and bounced the next post ${condition}`,
    lose: async ({ plugin, fake, room }: Bridge): Promise<void> => {
      // No presence at all: the server simply forgot us, exactly as a component restart does.
      fake.occupancyBounceCondition = condition;
      fake.forgetOccupancySilently(room);
      await expect(plugin.post(TOPIC, asHandle('a'), 'lost')).rejects.toThrow(condition);
    },
  })),
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

  it(`a ${VOICE_BOUNCE} bounce leaves occupancy alone instead of re-entering the room`, async () => {
    const bridge = await build();
    const { plugin, fake, p, room } = bridge;
    await plugin.post(TOPIC, asHandle('a'), 'before');
    const cachedJoin = p.joined.get(room);
    const joinsBefore = joinPresences(fake, room);

    fake.occupancyBounceCondition = VOICE_BOUNCE;
    fake.forgetOccupancySilently(room);
    await expect(plugin.post(TOPIC, asHandle('a'), 'muted')).rejects.toThrow(VOICE_BOUNCE);
    await new Promise((r) => setTimeout(r, 500)); // longer than REJOIN_BASE_MS + its jitter

    expect(joinPresences(fake, room)).toBe(joinsBefore);
    expect(p.joined.get(room)).toBe(cachedJoin);
    expect(p.rejoins.size).toBe(0);
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

// Class: a room-state event that arrives while the seam call REGISTERING interest in that room is
// still in flight. Every row above loses occupancy after subscribe() has returned, so none of them
// can reach the window inside it — and the recovery ladder is gated on `subscriptions.has(room)`,
// so interest written after the join means a loss delivered anywhere inside that join is classified
// as a catch-up-only room: one stderr line, no timer, the call resolving successfully and live push
// dead for a topic that may never see another post or fetch. The generator is over WHERE in the
// call the loss lands, and every cell asserts the same seam-observable end state — another
// occupant's message reaches this subscriber again — rather than a proxy for it.
const arrivals: Array<{ when: string; lose(bridge: SubBridge): void }> = [
  {
    when: 'before the call is made at all',
    lose: ({ fake, room }) => fake.endOccupancy(room, { statuses: ['307'] }),
  },
  {
    when: 'while the join presence is still unanswered',
    lose: ({ fake, room }) => {
      fake.joinLatencyMs = 80;
      setTimeout(() => fake.endOccupancy(room, { statuses: ['307'] }), 30);
    },
  },
  {
    when: 'after the self-presence, during the disco#info probe',
    lose: ({ fake, room }) => {
      let fired = false;
      fake.onDiscoRequest = () => {
        if (fired) return;
        fired = true;
        fake.endOccupancy(room, { statuses: ['307'] });
      };
      fake.discoLatencyMs = 20;
    },
  },
  { when: 'after the call returned', lose: () => undefined },
];

interface SubBridge {
  plugin: XmppPlugin;
  fake: FakeXmpp;
  p: XmppPrivate;
  room: string;
  delivered: string[];
}

describe('XMPP recovers live push when occupancy ends inside subscribe()', () => {
  it.each(arrivals)('the loss lands $when', async ({ when, lose }) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = new FakeXmpp();
    fake.enforceOccupancy = true;
    fake.nick = NICK;
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: NICK });
    const p = priv(plugin);
    const room = p.roomJid(TOPIC);
    const delivered: string[] = [];
    const bridge: SubBridge = { plugin, fake, p, room, delivered };

    lose(bridge);
    await plugin.subscribe(TOPIC, (m: Message) => delivered.push(String(m.content)));
    if (when === 'after the call returned') fake.endOccupancy(room, { statuses: ['307'] });

    // The fixture routes a room's traffic to its OCCUPANTS only, so this is dead until the plugin
    // is back in the room — no ladder, no delivery, whatever the join cache happens to say.
    await vi.waitFor(
      () => {
        fake.deliver(room, 'live-after-the-window');
        expect(delivered).toContain('live-after-the-window');
      },
      { timeout: REJOIN_MAX_WAIT_MS + 3_000, interval: 50 },
    );

    await plugin.disconnect();
    vi.restoreAllMocks();
  }, 30_000);

  // The rollback's own hazard: two callers share one cached join, so a failed subscribe that
  // deletes the ROOM entry rather than splicing its OWN handler silently unsubscribes the other —
  // a worse defect than the one the early registration fixes, and invisible in the cache.
  it('a subscribe whose join fails does not unsubscribe the caller already listening', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bridge = await build();
    const { plugin, fake, p, room, delivered } = bridge;
    await plugin.post(TOPIC, asHandle('a'), 'before');

    fake.forgetOccupancySilently(room);
    fake.joinReply = 'error';
    fake.joinErrorCondition = 'forbidden';
    await expect(plugin.post(TOPIC, asHandle('a'), 'lost')).rejects.toThrow('not-acceptable');

    const second: string[] = [];
    await expect(plugin.subscribe(TOPIC, (m: Message) => second.push(String(m.content)))).rejects.toThrow(
      'forbidden',
    );
    fake.joinReply = 'self';
    await vi.waitFor(
      () => {
        fake.deliver(room, 'still-listening');
        expect(delivered).toContain('still-listening');
      },
      { timeout: REJOIN_MAX_WAIT_MS + 3_000, interval: 50 },
    );
    expect(second).toEqual([]);
    expect(p.subscriptions.get(room)?.handlers).toHaveLength(1);

    await plugin.disconnect();
    vi.restoreAllMocks();
  }, 30_000);

  it('a subscribe whose join fails leaves no interest behind at all', async () => {
    const fake = new FakeXmpp();
    fake.joinReply = 'error';
    fake.joinErrorCondition = 'forbidden';
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: NICK });
    const p = priv(plugin);
    const room = p.roomJid(TOPIC);

    const both = await Promise.allSettled([
      plugin.subscribe(TOPIC, () => undefined),
      plugin.subscribe(TOPIC, () => undefined),
    ]);

    expect(both.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(p.subscriptions.has(room)).toBe(false);
    await plugin.disconnect();
  });
});

// Class: a constant table of protocol codes whose entries no row reaches. The XEP-0045 status code
// on the unavailable presence is the ONLY thing that distinguishes a kick from a ban from a service
// shutdown, and the plugin's whole use of it is one stderr line — so a map that had never been read
// by an assertion could be reduced to `return 'left the room'` with the entire package suite green,
// leaving an operator watching a room go quiet with no way to tell moderation from an outage. One
// row per entry, each asserting its own word, plus the joined form and the no-code fallback.

const errorsFor = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  spy.mock.calls.map((c) => String(c[0]));

interface EndReason {
  name: string;
  statuses?: string[];
  destroy?: boolean;
  reason: string;
}

const endReasons: EndReason[] = [
  { name: 'status 301', statuses: ['301'], reason: 'banned' },
  { name: 'status 307', statuses: ['307'], reason: 'kicked' },
  { name: 'status 321', statuses: ['321'], reason: 'affiliation change' },
  { name: 'status 322', statuses: ['322'], reason: 'room became members-only' },
  { name: 'status 332', statuses: ['332'], reason: 'MUC service shutting down' },
  { name: 'status 333', statuses: ['333'], reason: 'occupant technical error' },
  { name: 'a <destroy/>', destroy: true, reason: 'room destroyed' },
  { name: 'a kick during a shutdown', statuses: ['307', '332'], reason: 'kicked, MUC service shutting down' },
  { name: 'no code at all', statuses: [], reason: 'left the room' },
  { name: 'an unknown code', statuses: ['999'], reason: 'left the room' },
];

describe('XMPP reports why occupancy ended', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(endReasons)('$name is reported as "$reason"', ({ statuses, destroy, reason }) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    const room = priv(plugin).roomJid(TOPIC);
    attach(plugin, fake, room);

    fake.endOccupancy(room, { statuses, destroy });

    // Not subscribed, so the loss is reported and left alone — the reporting is the whole subject.
    expect(errorsFor(errors)).toEqual([`[parley-xmpp] occupancy in ${room} ended (${reason})`]);
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
