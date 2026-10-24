import { asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Class: state the transport silently drops on a reconnect and the plugin never rebuilds. The
// bundled @xmpp/reconnect re-establishes and re-auths the stream, but MUC occupancy is PRESENCE —
// it is not restored, and a room this connection is no longer in delivers nothing and bounces
// every post. So on every `online` after the first, the join presence must be re-sent for EVERY
// room this connection had entered, whichever seam call entered it: a room joined by
// post/fetchRecent alone (catch-up only, never subscribed) is just as unjoined as a subscribed
// one, and is the case a "re-join the subscriptions" loop silently misses. The table drives each
// way a room enters the join cache and demands a fresh join presence for it.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

// Imported after the mock is declared; vitest hoists vi.mock above all imports regardless.
import { XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv, type XmppPrivate } from './fake-xmpp.js';

const NS_MUC = 'http://jabber.org/protocol/muc';

describe('XMPP MUC re-join after reconnect', () => {
  afterEach(() => {
    mockState.client = undefined;
  });

  const entries = [
    { how: 'subscribed (live push)', subscribe: true },
    { how: 'catch-up only (post/fetchRecent, never subscribed)', subscribe: false },
  ];

  it.each(entries)(
    'skips the first online, then re-joins a room entered $how and fails in-flight posts',
    async ({ subscribe }) => {
      const fake = new FakeXmpp();
      mockState.client = fake;
      const plugin = new XmppPlugin();
      await plugin.connect({ username: 'parley', password: 's3cret-real-pw' });

      const topic = asTopic('t1');
      const room = priv(plugin).roomJid(topic);
      const originalJoin = Promise.resolve();
      if (subscribe) {
        priv(plugin).subscriptions.set(room, { topic, handlers: [() => undefined] });
      }
      priv(plugin).joined.set(room, originalJoin);
      let postErr: Error | undefined;
      priv(plugin).pendingPosts.set('o-x', {
        room,
        resolve: () => undefined,
        reject: (e: Error) => {
          postErr = e;
        },
      });

      // First `online` = the initial connect (guard consumes it; subscribe()/post() drove the joins).
      fake.emit('online');
      expect(fake.sent).toHaveLength(0);
      expect(priv(plugin).joined.get(room)).toBe(originalJoin); // untouched by the initial online

      // Second `online` = a reconnect: the stream re-authed but occupancy is gone.
      fake.emit('online');
      await Promise.resolve(); // flush the ensureJoined microtask chain

      // In-flight posts are failed fast (immediate retriable error, not a 15 s hang).
      expect(postErr?.message).toBe('reconnected; retry post');
      expect(priv(plugin).pendingPosts.size).toBe(0);
      // The stale join cache was cleared and re-populated (a NEW join, not the resolved cache).
      expect(priv(plugin).joined.get(room)).not.toBe(originalJoin);
      const rejoin = fake.sent.find((s) => s.is('presence'));
      expect(rejoin).toBeDefined();
      expect(rejoin?.attrs.to?.startsWith(`${room}/`)).toBe(true);
      expect(rejoin?.getChild('x', NS_MUC)).toBeDefined();

      await plugin.disconnect(); // clears the dangling join timer
    },
  );
});

// The same promise from the subscriber's side: whatever state a subscribed room is in when the
// stream comes back, a message the room delivers after the reconnect reaches the handler. `joined`
// is not the list of rooms owed a re-entry — a room whose deferred re-entry failed, or whose ladder
// gave up, has already left it while its subscription stands. The server forgets every occupancy
// on the reconnect, and the fixture routes a room's traffic to occupants only, so a room the plugin
// does not re-enter hears nothing.
describe('XMPP every subscribed room hears its room again after a reconnect', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mockState.client = undefined;
  });

  interface Rig {
    fake: FakeXmpp;
    p: XmppPrivate;
    room: string;
    /** While true, every stanza send rejects, as it does while the stream is down. */
    down: { on: boolean };
    subscribed: Promise<void>;
  }

  const states: Array<{ state: string; reach: (r: Rig) => Promise<void> }> = [
    { state: 'joined and settled', reach: async ({ subscribed }) => subscribed },
    {
      state: 'its join still in flight',
      reach: async ({ p, room }) => {
        expect(p.pendingJoins.has(room)).toBe(true);
      },
    },
    {
      state: 'a deferred re-entry pending',
      reach: async ({ fake, room, subscribed }) => {
        await subscribed;
        fake.endOccupancy(room, { statuses: ['307'] });
      },
    },
    {
      state: 'a deferred re-entry that already failed',
      reach: async ({ fake, p, room, down, subscribed }) => {
        await subscribed;
        down.on = true;
        fake.endOccupancy(room, { statuses: ['307'] });
        await vi.advanceTimersByTimeAsync(5_000);
        down.on = false;
        expect(p.joined.has(room)).toBe(false);
      },
    },
    {
      state: 'a re-entry ladder that gave up',
      reach: async ({ fake, p, room, subscribed }) => {
        await subscribed;
        fake.kickOnJoin = { statuses: ['307'] };
        fake.endOccupancy(room, { statuses: ['307'] });
        await vi.advanceTimersByTimeAsync(120_000);
        fake.kickOnJoin = undefined;
        expect(p.joined.has(room)).toBe(false);
      },
    },
  ];

  it.each(states)(
    'a subscribed room with $state',
    async ({ state, reach }) => {
      vi.useFakeTimers();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const fake = new FakeXmpp();
      const down = { on: false };
      const send = fake.send.bind(fake);
      fake.send = async (el: unknown) => {
        if (down.on) throw new Error('stream down');
        return send(el);
      };
      if (state === 'its join still in flight') fake.joinLatencyMs = 1_000;
      mockState.client = fake;
      const plugin = new XmppPlugin();
      await plugin.connect({ password: 'a-real-secret', nick: 'sub' });
      fake.emit('online'); // the initial connect, consumed by the first-online guard
      const topic = asTopic('t-reconnect-sub');
      const room = priv(plugin).roomJid(topic);
      const delivered: string[] = [];
      const subscribed = plugin.subscribe(topic, (m: Message) => delivered.push(String(m.content)));

      const p = priv(plugin);
      await reach({ fake, p, room, down, subscribed });
      expect(p.subscriptions.has(room)).toBe(true);

      fake.forgetOccupancySilently(room);
      fake.emit('online');
      await vi.advanceTimersByTimeAsync(20_000);
      await subscribed;

      fake.deliver(room, 'after-reconnect');
      expect(delivered).toContain('after-reconnect');
      await plugin.disconnect();
    },
    30_000,
  );
});
