import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { describe, expect, it, vi } from 'vitest';

// Class: a seam lifecycle call issued OUT OF ORDER that silently leaves the previous transport
// live. `@xmpp/reconnect` is listening from the moment a client is constructed, so a client this
// plugin drops without stopping goes on redialling — re-presenting `backend_config.password` to a
// server nothing above the seam believes it is still talking to — while its stanza handlers keep
// driving the `joined`/`roomNicks` state that now belongs to a different connection.
// connect-teardown.test.ts covers only the failed-connect arm, and it covers it against a real
// socket; every row here is an ordering a supervisor or a retry loop produces, graded on one
// invariant: exactly one client is live afterwards, and it is the one the plugin holds.

const mockState = vi.hoisted(() => ({ make: undefined as undefined | (() => unknown) }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.make?.() };
});

import { XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv } from './fake-xmpp.js';

const NS_SID = 'urn:xmpp:sid:0';
const TOPIC = asTopic('lifecycle');
const CONFIG = { password: 'a-real-secret', nick: 'reader' };

interface Row {
  name: string;
  /** The sequence, asserting each step's own outcome. `fakes` grows as clients are constructed. */
  run(plugin: XmppPlugin, fakes: FakeXmpp[]): Promise<void>;
  /** How many clients the sequence must have constructed — a fail-fast builds no second one. */
  clients: number;
  /** Whether the plugin holds a client at the end (and so can still be driven). */
  holding: boolean;
}

const rejects = async (op: Promise<unknown>, pattern: RegExp): Promise<void> => {
  await expect(op).rejects.toThrow(pattern);
};

const rows: Row[] = [
  {
    name: 'connect on an already-connected plugin is refused, and the first stays live',
    clients: 1,
    holding: true,
    run: async (plugin) => {
      await plugin.connect(CONFIG);
      await rejects(plugin.connect(CONFIG), /already connected/i);
    },
  },
  {
    name: 'connect, disconnect, connect replaces the client cleanly',
    clients: 2,
    holding: true,
    run: async (plugin) => {
      await plugin.connect(CONFIG);
      await plugin.disconnect();
      await plugin.connect(CONFIG);
    },
  },
  {
    name: 'connect after a FAILED connect is allowed — the failure took ownership of its client',
    clients: 2,
    holding: true,
    run: async (plugin, fakes) => {
      await rejects(plugin.connect(CONFIG), /no stream/i);
      expect(fakes[0]?.stops).toBe(1);
      await plugin.connect(CONFIG);
    },
  },
  {
    name: 'disconnect with no connect is a no-op, and repeating it is too',
    clients: 0,
    holding: false,
    run: async (plugin) => {
      await plugin.disconnect();
      await plugin.disconnect();
    },
  },
  {
    name: 'disconnect twice after a connect stops the client exactly once',
    clients: 1,
    holding: false,
    run: async (plugin, fakes) => {
      await plugin.connect(CONFIG);
      await plugin.disconnect();
      await plugin.disconnect();
      expect(fakes[0]?.stops).toBe(1);
    },
  },
  {
    name: 'subscribe after disconnect is refused, not silently dead',
    clients: 1,
    holding: false,
    run: async (plugin) => {
      await plugin.connect(CONFIG);
      await plugin.disconnect();
      await rejects(
        plugin.subscribe(TOPIC, () => undefined),
        /not connected/i,
      );
    },
  },
  {
    name: 'post after disconnect is refused, not silently dropped',
    clients: 1,
    holding: false,
    run: async (plugin) => {
      await plugin.connect(CONFIG);
      await plugin.disconnect();
      await rejects(plugin.post(TOPIC, asHandle('reader'), 'hi'), /not connected/i);
    },
  },
  {
    name: 'fetchRecent after disconnect is refused, not an empty page',
    clients: 1,
    holding: false,
    run: async (plugin) => {
      await plugin.connect(CONFIG);
      await plugin.disconnect();
      await rejects(plugin.fetchRecent({ topic: TOPIC, limit: 10 }), /not connected/i);
    },
  },
];

describe('XMPP lifecycle calls out of order leave exactly one live transport', () => {
  it.each(rows)('$name', async (row) => {
    const fakes: FakeXmpp[] = [];
    mockState.make = () => {
      const fake = new FakeXmpp();
      if (fakes.length === 0 && row.name.includes('FAILED')) fake.startError = 'no stream';
      fakes.push(fake);
      return fake;
    };
    const plugin = new XmppPlugin();
    try {
      await row.run(plugin, fakes);

      expect(fakes).toHaveLength(row.clients);
      const held = priv(plugin).xmpp;
      expect(held !== undefined).toBe(row.holding);
      const heldIndex = fakes.findIndex((f) => f === held);
      const liveIndexes = fakes.flatMap((f, i) => (f.stops === 0 ? [i] : []));
      expect(liveIndexes).toEqual(heldIndex === -1 ? [] : [heldIndex]);
      if (!row.holding) return;

      // The held client delivers; every client this plugin walked away from delivers nothing —
      // an abandoned one would still be running, and its handlers still point at this plugin.
      const delivered: Message[] = [];
      await plugin.subscribe(TOPIC, (m) => delivered.push(m));
      const room = priv(plugin).roomJid(TOPIC);
      for (const [i, fake] of fakes.entries()) {
        fake.feed(
          xml(
            'message',
            { from: `${room}/someone`, type: 'groupchat' },
            xml('body', {}, `from-client-${i}`),
            xml('stanza-id', { xmlns: NS_SID, by: room, id: `orphan-${i}` }),
          ),
        );
      }
      expect(delivered.map((m) => m.content)).toEqual([`from-client-${heldIndex}`]);
    } finally {
      await plugin.disconnect();
      mockState.make = undefined;
    }
  });
});
