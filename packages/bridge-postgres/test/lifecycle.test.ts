import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';

// Deterministic listener-lifecycle tests for BUG-16 (disconnect() racing a reconnect must leak no
// live Client) and BUG-29 (a failed LISTEN leaves no registration; repeat subscribe fans out).
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
  // When true, `query('LISTEN …')` rejects (drives the BUG-29(1) failed-subscribe path).
  listenRejects: false,
  // Rows the pool hands back on the NEXT drain SELECT (then it is emptied — one delivery).
  drainRows: [] as Record<string, unknown>[],
}));

interface MockClientShape {
  ended: boolean;
  emit: (event: string, arg?: unknown) => void;
}

vi.mock('pg', () => {
  class MockClient implements MockClientShape {
    private readonly handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    ended = false;
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
      return { rows: [] };
    }
    async end(): Promise<void> {
      this.ended = true;
    }
  }

  const poolQuery = async (sql: string): Promise<{ rows: unknown[] }> => {
    if (/MAX\(seq\)/.test(sql)) return { rows: [{ max: '0' }] };
    // Drain SELECT (seq > $2, ascending): hand back the queued rows once, then nothing.
    if (/seq > \$2/.test(sql)) {
      const rows = state.drainRows.splice(0);
      return { rows };
    }
    return { rows: [] };
  };

  return {
    Pool: vi.fn(() => ({
      on: vi.fn(),
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      })),
      query: vi.fn(poolQuery),
      end: vi.fn(async () => undefined),
    })),
    Client: MockClient,
  };
});

// A real DSN so the SEC-06 default-credential warning stays quiet.
const REAL_URL = 'postgres://app:s3cret@db.example.com:5432/prod';

beforeEach(() => {
  state.clients.length = 0;
  state.connectGate = null;
  state.listenRejects = false;
  state.drainRows.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Postgres listener lifecycle (BUG-16)', () => {
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

describe('Postgres subscribe registration (BUG-29)', () => {
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
    state.drainRows.push({
      seq: '1',
      topic: 't',
      sender: asHandle('u'),
      content: 'hi',
      ts: new Date().toISOString(),
      in_reply_to: null,
    });
    const listener = state.clients[0];
    listener?.emit('notification', { channel });
    await sleep(50);

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(seen1[0]?.content).toBe('hi');

    await plugin.disconnect();
  });
});
