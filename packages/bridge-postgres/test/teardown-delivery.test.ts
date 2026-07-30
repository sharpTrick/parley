import { asTopic, type Topic } from '@sharptrick/parley-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { channelFor } from '../src/schema.js';

// `disconnect()` drops every subscription synchronously, but a drain read is already at the server
// when it does — and `pool.end()` waits for that read, so it comes back with rows AFTER the
// subscription it belongs to has been cancelled. Every other await in this plugin re-checks the
// lifecycle epoch on the far side; the drain's did not, so the last batch was fanned out to handlers
// on the way out. Through core's push loop that is a `<channel>` event injected into a session the
// bridge has already shut down.
//
// The property is one line — after `disconnect()`, no handler is ever called again — and it has to
// hold for every path that can be parked on a read at teardown, so the read is gated on a deferred
// this test controls rather than on a sleep, and the table covers each way a drain gets started.

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  clients: [] as { emit: (event: string, arg?: unknown) => void }[],
  /** Set to park every windowed read until released — the exact teardown window. */
  gate: null as null | Promise<void>,
  releaseGate: null as null | (() => void),
  gateHits: 0,
}));

vi.mock('pg', async () => {
  const { servePool } = await import('./fake-pg.js');

  class MockClient {
    private readonly handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    constructor() {
      state.clients.push(this);
    }
    on(event: string, cb: (arg?: unknown) => void): void {
      (this.handlers[event] ??= []).push(cb);
    }
    emit(event: string, arg?: unknown): void {
      for (const cb of this.handlers[event] ?? []) cb(arg);
    }
    async connect(): Promise<void> {}
    async query(): Promise<{ rows: unknown[] }> {
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }

  const query = async (sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> => {
    if (state.gate !== null && /seq > \$\d+::bigint/.test(sql)) {
      state.gateHits++;
      await state.gate;
    }
    return { rows: servePool(state.rows, sql, values ?? []) ?? [] };
  };

  return {
    Pool: vi.fn(() => ({
      on: vi.fn(),
      connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })),
      query: vi.fn(query) as unknown as typeof query,
      end: vi.fn(async () => undefined),
    })),
    Client: MockClient,
  };
});

const URL = 'postgres://app:s3cret@db.example.com:5432/prod';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Whatever `drain()` batches at once — the row counts either side of it are the interesting ones. */
const DRAIN_BATCH = 512;

function seed(topic: Topic, count: number): void {
  state.rows = Array.from({ length: count }, (_, i) => ({
    seq: String(i + 1),
    topic: String(topic),
    sender: 'u',
    content: `m${i + 1}`,
    ts: new Date().toISOString(),
    in_reply_to: null,
  }));
}

async function until(predicate: () => boolean, budgetMs = 5000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate() && Date.now() < deadline) await sleep(5);
}

/** How the drain that will be parked at teardown got started. */
type Trigger = 'a NOTIFY' | 'the listener reconnecting';

// Row counts a batch boundary makes distinct; every one of them delivers at least one message when
// the re-check is missing, so no cell here can pass by doing nothing.
const ROW_COUNTS = [1, 2, DRAIN_BATCH + 1];

const CELLS = (['a NOTIFY', 'the listener reconnecting'] as Trigger[]).flatMap((trigger) =>
  ROW_COUNTS.map((rows) => ({ trigger, rows })),
);

beforeEach(() => {
  state.rows = [];
  state.clients = [];
  state.gate = null;
  state.releaseGate = null;
  state.gateHits = 0;
});

describe('a read in flight at teardown delivers nothing once the subscription is cancelled', () => {
  it.each(
    CELLS.map(
      (c) => [`drain started by ${c.trigger}, ${c.rows} row(s) waiting`, c] as const,
    ),
  )('%s', async (_label, cell) => {
    const topic = asTopic('teardown');
    const plugin = new PostgresPlugin();
    const got: string[] = [];
    await plugin.connect({ url: URL, table_name: 'parley_td' });
    try {
      await plugin.subscribe(topic, (m) => got.push(m.content));
      // The subscribe's own drain must finish before the gate goes up, so the read this test parks
      // is the one the trigger below starts.
      await sleep(50);
      expect(got, 'push replayed history').toEqual([]);

      seed(topic, cell.rows);
      state.gate = new Promise<void>((resolve) => {
        state.releaseGate = resolve;
      });

      if (cell.trigger === 'a NOTIFY') {
        for (const c of state.clients) c.emit('notification', { channel: channelFor(topic) });
      } else {
        for (const c of state.clients) c.emit('end');
      }
      await until(() => state.gateHits > 0);
      expect(state.gateHits, 'no read was parked, so this cell proves nothing').toBeGreaterThan(0);

      await plugin.disconnect();
      state.releaseGate?.();
      await sleep(100);

      expect(got, 'a cancelled subscription was handed one last batch').toEqual([]);
    } finally {
      state.releaseGate?.();
      state.gate = null;
      await plugin.disconnect().catch(() => undefined);
    }
  }, 30000);
});
