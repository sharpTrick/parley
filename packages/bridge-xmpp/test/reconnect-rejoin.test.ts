import { asTopic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
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
import { priv } from './fake-xmpp.js';

const NS_MUC = 'http://jabber.org/protocol/muc';

interface Stanza {
  is(name: string, ns?: string): boolean;
  attrs: Record<string, string>;
  getChild(name: string, ns?: string): unknown;
}
interface FakeClient {
  sent: Stanza[];
  on(event: string, cb: (arg?: unknown) => void): void;
  emit(event: string): void;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  send(el: unknown): Promise<unknown>;
  iqCaller: { request(el: unknown, t?: number): Promise<unknown> };
  jid: { toString(): string };
}

const makeFakeClient = (): FakeClient => {
  const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
  const sent: Stanza[] = [];
  return {
    sent,
    on(event, cb) {
      (handlers[event] ??= []).push(cb);
    },
    emit(event) {
      for (const cb of handlers[event] ?? []) cb();
    },
    start: async () => undefined,
    stop: async () => undefined,
    send: async (el: unknown) => {
      sent.push(el as Stanza);
      return undefined;
    },
    iqCaller: { request: async () => xml('iq', { type: 'result' }) },
    jid: { toString: () => 'parley@parley.local/r' },
  };
};

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
      const fake = makeFakeClient();
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
