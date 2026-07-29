import { asCursor, asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';

// Deterministic listener-lifecycle tests: a disconnect() racing a reconnect must leak no live
// Client, a failed LISTEN must leave no registration, and a repeat subscribe must fan out.
// These never touch a real server: `pg` is mocked so `new Client()` (the LISTEN connection) is a
// controllable stub. The network-gated conformance suite covers the live paths.

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Shared mock state, hoisted so the vi.mock factory can close over it.
const state = vi.hoisted(() => ({
  clients: [] as MockClientShape[],
  // When set, the next `new Client().connect()` parks on this deferred (used to hold a reconnect
  // candidate mid-connect while a disconnect() races it).
  connectGate: null as Deferred | null,
  // When true, `query('LISTEN …')` rejects (drives the failed-subscribe path).
  listenRejects: false,
  // The table, per topic. Rows STAY here: what a query returns is decided by the SQL's cursor
  // predicate and ORDER BY, exactly as the server decides it.
  rows: new Map<string, Record<string, unknown>[]>(),
}));

interface MockClientShape {
  ended: boolean;
  listened: string[];
  emit: (event: string, arg?: unknown) => void;
}

vi.mock('pg', async () => {
  const { servePool } = await import('./fake-pg.js');

  class MockClient implements MockClientShape {
    private readonly handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    ended = false;
    readonly listened: string[] = [];
    constructor() {
      state.clients.push(this);
    }
    on(event: string, cb: (arg?: unknown) => void): void {
      (this.handlers[event] ??= []).push(cb);
    }
    emit(event: string, arg?: unknown): void {
      for (const cb of this.handlers[event] ?? []) cb(arg);
    }
    async connect(): Promise<void> {
      const gate = state.connectGate;
      if (gate !== null) {
        state.connectGate = null;
        await gate.promise;
      }
    }
    async query(sql: string): Promise<{ rows: unknown[] }> {
      if (state.listenRejects && /LISTEN/.test(sql)) throw new Error('LISTEN failed (mock)');
      const listen = /^LISTEN "(.+)"$/.exec(sql);
      if (listen !== null) this.listened.push(listen[1] as string);
      return { rows: [] };
    }
    async end(): Promise<void> {
      this.ended = true;
    }
  }

  const poolQuery = async (sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> => {
    const served = servePool(state.rows.get(String(values?.[0])) ?? [], sql, values ?? []);
    return { rows: served ?? [] };
  };

  return {
    Pool: vi.fn(() => ({
      on: vi.fn(),
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      })),
      query: vi.fn(poolQuery) as unknown as typeof poolQuery,
      end: vi.fn(async () => undefined),
    })),
    Client: MockClient,
  };
});

// A real DSN so the default-credential warning stays quiet.
const REAL_URL = 'postgres://app:s3cret@db.example.com:5432/prod';

beforeEach(() => {
  state.clients.length = 0;
  state.connectGate = null;
  state.listenRejects = false;
  state.rows.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Postgres listener lifecycle', () => {
  it('a disconnect() racing an in-flight reconnect ends the candidate and does not resurrect the listener', async () => {
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });
    await plugin.subscribe(asTopic('t'), () => undefined);

    const priv = plugin as unknown as {
      listener?: unknown;
      listenerPromise?: unknown;
    };
    const client0 = state.clients[0];
    expect(client0).toBeDefined();

    // Hold the reconnect candidate's connect() open, then drop the live listener so the 'end'
    // handler kicks off reconnectListener(). (connect() nulls state.connectGate when it consumes
    // the gate, so keep a local reference to release it later.)
    const gate = deferred();
    state.connectGate = gate;
    client0?.emit('end');

    // Wait past the reconnect backoff (RECONNECT_DELAY_MS = 500ms) so the candidate reaches its
    // parked connect(); a second Client now exists but is stuck.
    await sleep(700);
    expect(state.clients.length).toBe(2);
    const candidate = state.clients[1];
    expect(candidate?.ended).toBe(false);

    // disconnect() wins the race: it completes teardown while the candidate is mid-connect.
    await plugin.disconnect();
    expect(priv.listener).toBeUndefined();
    expect(priv.listenerPromise).toBeUndefined();

    // Now let the candidate's connect() resolve. The post-await stopped check must end it and
    // return WITHOUT publishing this.listener.
    gate.resolve();
    await sleep(50);

    expect(candidate?.ended).toBe(true);
    expect(priv.listener).toBeUndefined();
    expect(priv.listenerPromise).toBeUndefined();
  }, 5000);
});

describe('Postgres subscribe registration', () => {
  it('a subscribe whose LISTEN rejects leaves no entry in this.subs', async () => {
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });

    state.listenRejects = true;
    await expect(plugin.subscribe(asTopic('t'), () => undefined)).rejects.toThrow(/LISTEN failed/);

    const subs = (plugin as unknown as { subs: Map<string, unknown> }).subs;
    expect(subs.size).toBe(0);

    await plugin.disconnect();
  });

  it('two subscribes to the same topic fan out to both handlers, and one throwing handler does not starve the other', async () => {
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });

    const seen1: Message[] = [];
    const h1 = vi.fn(() => {
      throw new Error('handler boom');
    });
    const h2 = vi.fn((m: Message) => {
      seen1.push(m);
    });

    await plugin.subscribe(asTopic('t'), h1);
    await plugin.subscribe(asTopic('t'), h2);

    const subs = (plugin as unknown as { subs: Map<string, { handlers: unknown[] }> }).subs;
    expect(subs.size).toBe(1);
    const [channel, sub] = [...subs.entries()][0]!;
    expect(sub.handlers.length).toBe(2);

    // Deliver one row via a NOTIFY on the shared listener connection.
    state.rows.set('t', [
      {
        seq: '1',
        topic: 't',
        sender: asHandle('u'),
        content: 'hi',
        ts: new Date().toISOString(),
        in_reply_to: null,
      },
    ]);
    const listener = state.clients[0];
    listener?.emit('notification', { channel });
    await sleep(50);

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(seen1[0]?.content).toBe('hi');

    await plugin.disconnect();
  });
});

// The reconnect loop exists to make a notification blackout cost latency and not a message: it
// must re-LISTEN every channel a subscription or an in-flight blocking fetch still needs, and
// re-drain every topic from its cursor. Asserting only that it must NOT resurrect a listener after
// disconnect leaves the delivery guarantee itself unguarded, so this matrix pins it directly.

const DRAIN_BATCH = 512;

interface ReconnectCell {
  topics: number;
  waiters: number;
  rows: number;
}

const RECONNECT_CELLS: ReconnectCell[] = [0, 1, 2].flatMap((topics) =>
  [0, 1].flatMap((waiters) =>
    [0, 1, DRAIN_BATCH + 1].map((rows) => ({ topics, waiters, rows })),
  ),
);

function blackoutRows(topic: string, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: String(i + 1),
    topic,
    sender: asHandle('u'),
    content: `m${i}`,
    ts: new Date().toISOString(),
    in_reply_to: null,
  }));
}

describe('Postgres listener reconnect delivers what the blackout missed', () => {
  it.each(
    RECONNECT_CELLS.map(
      (c) =>
        [`${c.topics} subscription(s), ${c.waiters} blocking waiter(s), ${c.rows} row(s)`, c] as const,
    ),
  )('%s', async (_label, cell) => {
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });

    const seen = new Map<string, Message[]>();
    const subTopics = Array.from({ length: cell.topics }, (_, i) => `sub${i}`);
    for (const t of subTopics) {
      seen.set(t, []);
      await plugin.subscribe(asTopic(t), (m) => {
        seen.get(t)?.push(m);
      });
    }

    const waitTopic = 'waiting';
    const waits: Promise<unknown>[] = [];
    if (cell.waiters > 0) {
      waits.push(
        plugin.fetchRecent({ topic: asTopic(waitTopic), since: asCursor('0'), blockMs: 4000 }),
      );
      await sleep(20);
    }

    const channelsNeeded = [...(plugin as unknown as { listens: Map<string, unknown> }).listens.keys()];

    // Queue the blackout rows, then drop the listener connection.
    for (const t of subTopics) state.rows.set(t, blackoutRows(t, cell.rows));
    const listener = state.clients[0];
    if (listener === undefined) {
      // Nothing subscribed and nothing waiting: the listener connection is lazy, so there is no
      // blackout to recover from.
      expect(channelsNeeded).toEqual([]);
      await plugin.disconnect();
      return;
    }
    listener.emit('end');

    // Past the reconnect backoff, the replacement client must be live.
    await sleep(900);
    const replacement = state.clients.at(-1);
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(listener);
    for (const channel of channelsNeeded) {
      expect(replacement?.listened, `re-LISTEN missing for ${channel}`).toContain(channel);
    }

    // No NOTIFY is emitted: the reconnect's own re-drain is what must deliver these.
    await sleep(100);
    for (const t of subTopics) {
      const got = seen.get(t) ?? [];
      expect(got.map((m) => m.content)).toEqual(
        Array.from({ length: cell.rows }, (_, i) => `m${i}`),
      );
      expect(new Set(got.map((m) => m.backendMsgId)).size, 'duplicate delivery').toBe(got.length);
    }

    await plugin.disconnect();
    await Promise.all(waits);
  }, 15000);
});
