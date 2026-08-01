import { asHandle, asTopic } from '@sharptrick/parley-core';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';

// Class: a teardown that INTERLEAVES with a setup call still in flight, rather than following it.
// Every lifecycle guard in this plugin is a check-then-act across an await — `connect` reads
// `this.xmpp`, parks on `xmpp.start()` and assigns afterwards; `post`/`subscribe`/`fetchRecent`
// resolve the connection, park on a MUC join or a MAM round trip and register afterwards — so a
// `disconnect()` landing inside any of those windows can find nothing to tear down and still be
// overtaken by the call it was meant to cancel. The damage is the same one lifecycle-order.test.ts
// grades for out-of-order calls: `@xmpp/reconnect` keeps a client alive from construction, so a
// stream nobody holds goes on redialling with `backend_config.password` while its stanza handlers
// still drive this plugin, and the plugin that owns nothing refuses every later connect().
//
// Parameterized over the AWAIT the raced call is held at, not over one caller: the next such window
// is a new row here, and every row is graded on the same two invariants — a `disconnect()` that has
// returned leaves nothing live, and the call it raced leaves the plugin fully disconnected rather
// than half-initialised.

const mockState = vi.hoisted(() => ({ make: undefined as undefined | (() => unknown) }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: (...args: unknown[]) => mockState.make?.() ?? actual.client(...args) };
});

import { XmppPlugin } from '../src/index.js';
import { expectNoLeaks, FakeXmpp, priv } from './fake-xmpp.js';
import { BASE, canAuth } from './live-xmpp.js';

const TOPIC = asTopic('raced');
const CONFIG = { password: 'a-real-secret', nick: 'reader' };

const gate = (): { promise: Promise<void>; open: () => void } => {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
};

const until = async (ready: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`the raced call never reached ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
};

interface Held {
  /** Whether the raced call has actually reached the await this row holds it at. */
  reached(plugin: XmppPlugin): boolean;
  /** Let the held call proceed — called only once `disconnect()` has already returned. */
  release(): void;
}

interface Race {
  name: string;
  /** A completed lifecycle step this row races from; rows that race `connect` itself have none. */
  setUp?(plugin: XmppPlugin): Promise<void>;
  /** Wires the client so this row's call parks at one specific await inside the plugin. */
  hold(fake: FakeXmpp): Held;
  call(plugin: XmppPlugin): Promise<unknown>;
  /** Whether the raced call MUST report failure: a resolve tells its caller "connected". */
  mustReject: boolean;
}

const connected = async (plugin: XmppPlugin): Promise<void> => {
  await plugin.connect(CONFIG);
};

/** Parked on the MUC join every seam call funnels through: a room that never answers presence. */
const heldAtJoin = (fake: FakeXmpp): Held => {
  fake.joinReply = 'silent';
  return {
    reached: (plugin) => priv(plugin).pendingJoins.size > 0,
    release: () => undefined,
  };
};

/** Parked on the MAM round trip both the catch-up and the long-poll read paths go through. */
const heldAtMam = (fake: FakeXmpp): Held => {
  const g = gate();
  let arrived = false;
  fake.onMamRequest = async () => {
    arrived = true;
    await g.promise;
  };
  return { reached: () => arrived, release: g.open };
};

const rows: Race[] = [
  {
    name: 'connect, parked on a stream that then comes up',
    hold: (fake) => {
      const g = gate();
      fake.startGate = g.promise;
      return { reached: () => true, release: g.open };
    },
    call: (plugin) => plugin.connect(CONFIG),
    mustReject: true,
  },
  {
    name: 'connect, parked on a stream that then fails to come up',
    hold: (fake) => {
      const g = gate();
      fake.startGate = g.promise;
      fake.startError = 'no stream';
      return { reached: () => true, release: g.open };
    },
    call: (plugin) => plugin.connect(CONFIG),
    mustReject: true,
  },
  {
    name: 'subscribe, parked on the MUC join',
    setUp: connected,
    hold: heldAtJoin,
    call: (plugin) => plugin.subscribe(TOPIC, () => undefined),
    mustReject: true,
  },
  {
    name: 'post, parked on the MUC join',
    setUp: connected,
    hold: heldAtJoin,
    call: (plugin) => plugin.post(TOPIC, asHandle('reader'), 'hi'),
    mustReject: true,
  },
  {
    name: 'fetchRecent, parked on a MAM round trip',
    setUp: connected,
    hold: heldAtMam,
    call: (plugin) => plugin.fetchRecent({ topic: TOPIC, limit: 10 }),
    mustReject: false,
  },
  {
    name: 'a blocking fetchRecent, parked on a MAM round trip',
    setUp: connected,
    hold: heldAtMam,
    call: (plugin) => plugin.fetchRecent({ topic: TOPIC, limit: 10, blockMs: 500 }),
    mustReject: false,
  },
];

describe('an XMPP disconnect that races a setup call still leaves nothing live', () => {
  it.each(rows)('$name', async (row) => {
    const fakes: FakeXmpp[] = [];
    let held: Held | undefined;
    mockState.make = () => {
      const fake = new FakeXmpp();
      held ??= row.hold(fake);
      fakes.push(fake);
      return fake;
    };
    const plugin = new XmppPlugin();
    const live = (): number[] => fakes.flatMap((f, i) => (f.stops === 0 ? [i] : []));
    try {
      await row.setUp?.(plugin);
      const outcome = row.call(plugin).then(
        () => 'resolved' as const,
        (err: unknown) => err as Error,
      );
      await until(() => held?.reached(plugin) === true, row.name);

      await plugin.disconnect();
      expect(priv(plugin).xmpp, 'disconnect() returned holding a client').toBeUndefined();
      expect(live(), 'disconnect() returned with a client still running').toEqual([]);

      held?.release();
      const settled = await outcome;
      if (row.mustReject) expect(settled).toBeInstanceOf(Error);

      expect(priv(plugin).xmpp, 'the raced call adopted a client after disconnect()').toBeUndefined();
      expect(live(), 'the raced call left a client running after disconnect()').toEqual([]);
      expect([...priv(plugin).joined.keys()]).toEqual([]);
      expect(priv(plugin).subscriptions.size).toBe(0);
      expectNoLeaks(plugin);

      // Nothing above the seam can tell a half-initialised plugin from a disconnected one except by
      // driving it: a supervisor's next act after disconnect() is connect().
      await plugin.connect(CONFIG);
    } finally {
      held?.release();
      await plugin.disconnect();
      mockState.make = undefined;
    }
  });
});

// The neighbouring interleaving, on the same window: two SETUP calls. lifecycle-order.test.ts grades
// the sequential form, where the second connect() sees the first's adopted client and is refused;
// inside this window there is no adopted client to see, and admitting the second one abandons a
// stream that is already dialling.
describe('a second XMPP connect while the first is still coming up is refused', () => {
  it('no second client is built, and the plugin ends up holding the first', async () => {
    const fakes: FakeXmpp[] = [];
    const g = gate();
    mockState.make = () => {
      const fake = new FakeXmpp();
      if (fakes.length === 0) fake.startGate = g.promise;
      fakes.push(fake);
      return fake;
    };
    const plugin = new XmppPlugin();
    try {
      const first = plugin.connect(CONFIG);
      await expect(plugin.connect(CONFIG)).rejects.toThrow(/already connected/i);
      expect(fakes).toHaveLength(1);

      g.open();
      await first;
      expect(priv(plugin).xmpp).toBe(fakes[0]);
    } finally {
      g.open();
      await plugin.disconnect();
      mockState.make = undefined;
    }
  });
});

const serverUp = await canAuth(BASE);

/**
 * A stalling TCP proxy in front of the real server: it accepts the plugin's connection and holds
 * every byte until `open()`, so the handshake can be made to finish at a chosen moment — after the
 * disconnect — rather than in the microseconds a local server normally takes.
 */
const stallingProxy = async (): Promise<{
  port: number;
  connections: () => number;
  open: () => void;
  bytesFromClient: () => number;
  close: () => Promise<void>;
}> => {
  const upstream = new URL(BASE.service ?? 'xmpp://127.0.0.1:5222');
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let fromClient = 0;
  let accepted = 0;
  const sockets: net.Socket[] = [];

  const server = net.createServer((down) => {
    accepted++;
    sockets.push(down);
    down.on('error', () => undefined);
    const held: Buffer[] = [];
    let up: net.Socket | undefined;
    down.on('data', (chunk) => {
      fromClient += chunk.length;
      if (up === undefined) held.push(chunk);
      else up.write(chunk);
    });
    void gate.then(() => {
      const forward = net.connect(Number(upstream.port), upstream.hostname);
      sockets.push(forward);
      forward.on('error', () => undefined);
      forward.on('data', (chunk) => down.write(chunk));
      forward.on('connect', () => {
        for (const chunk of held) forward.write(chunk);
        held.length = 0;
        up = forward;
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    connections: () => accepted,
    open: release,
    bytesFromClient: () => fromClient,
    close: async () => {
      release();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
};

// The same class with no '@xmpp/client' mock and a REAL server behind the stall, because the arm
// that matters is the one the fixtures cannot show on their own authority: the stream comes up
// after the disconnect returned. An adopted one is authenticated with backend_config.password and
// nothing above the seam holds it — so the grade is that the plugin never speaks again once
// disconnect() has returned, whatever the peer then offers it.
describe.skipIf(!serverUp)('an XMPP disconnect during a connect abandons no live stream (live server)', () => {
  it('a stream that comes up after the disconnect is stopped, not adopted', async () => {
    const proxy = await stallingProxy();
    const plugin = new XmppPlugin();
    const connecting = plugin
      .connect({ ...BASE, service: `xmpp://127.0.0.1:${proxy.port}` })
      .then(
        () => 'resolved' as const,
        (err: unknown) => err as Error,
      );
    try {
      await until(() => proxy.connections() > 0, 'the proxy');

      await plugin.disconnect();
      const spoken = proxy.bytesFromClient();

      proxy.open();
      const settled = await Promise.race([
        connecting,
        new Promise<'never settled'>((r) => setTimeout(() => r('never settled'), 15_000)),
      ]);

      expect(settled, 'connect() reported success after disconnect() had returned').toBeInstanceOf(
        Error,
      );
      expect(priv(plugin).xmpp, 'the raced connect adopted the stream anyway').toBeUndefined();
      expect(
        proxy.bytesFromClient() - spoken,
        'the abandoned client went on talking to the server after disconnect() returned',
      ).toBe(0);
    } finally {
      await proxy.close();
      await plugin.disconnect();
    }
  }, 45_000);
});
