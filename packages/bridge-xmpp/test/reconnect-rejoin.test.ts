import { asTopic, type Topic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// BUG-06 — MUC re-join after @xmpp/client auto-reconnect. The bundled @xmpp/reconnect
// transparently re-establishes and re-auths the stream, but MUC occupancy is presence-based and
// is NOT restored by the library. On every `online` AFTER the first, the plugin must clear its
// join cache and re-send the join presence for every subscribed room (so push resumes and post()
// doesn't wait out its reflection timeout). Exercised by mocking @xmpp/client's `client()` to a
// controllable fake and emitting a synthetic second `online`.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

// Imported after the mock is declared; vitest hoists vi.mock above all imports regardless.
import { XmppPlugin } from '../src/index.js';

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
interface XmppPrivate {
  joined: Map<string, Promise<void>>;
  subscriptions: Map<string, { topic: Topic; handlers: Array<(m: unknown) => void> }>;
  pendingPosts: Map<string, { resolve(id: unknown): void; reject(err: Error): void }>;
  roomJid(topic: Topic): string;
}
const priv = (p: XmppPlugin): XmppPrivate => p as unknown as XmppPrivate;

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

describe('XMPP MUC re-join after reconnect (BUG-06)', () => {
  afterEach(() => {
    mockState.client = undefined;
  });

  it('skips the first online, then re-sends join presence + fails in-flight posts on a reconnect online', async () => {
    const fake = makeFakeClient();
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ username: 'parley', password: 's3cret-real-pw' });

    // Simulate the state an initial subscribe()/post() leaves behind: a live subscription and a
    // cached, resolved join for its room, plus one in-flight post awaiting its MUC reflection.
    const topic = asTopic('t1');
    const room = priv(plugin).roomJid(topic);
    const originalJoin = Promise.resolve();
    priv(plugin).subscriptions.set(room, { topic, handlers: [() => undefined] });
    priv(plugin).joined.set(room, originalJoin);
    let postErr: Error | undefined;
    priv(plugin).pendingPosts.set('o-x', {
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
    // A fresh MUC join presence was re-sent for the subscribed room.
    const rejoin = fake.sent.find((s) => s.is('presence'));
    expect(rejoin).toBeDefined();
    expect(rejoin?.attrs.to?.startsWith(`${room}/`)).toBe(true);
    expect(rejoin?.getChild('x', NS_MUC)).toBeDefined();

    await plugin.disconnect(); // clears the dangling join timer
  });
});
