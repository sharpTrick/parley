import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { sleep } from './pg-harness.js';

// Class: a teardown that INTERLEAVES with a setup call still in flight, rather than following it.
// Every resource this plugin owns is built, awaited, and only then published — `connect()` builds a
// Pool, checks a connection out of it and runs the bootstrap under an advisory lock before
// assigning `this.pool`; the listener socket is dialled before `adoptListener` assigns
// `this.listener` — so a `disconnect()` landing inside one of those windows finds a field that is
// still `undefined`, tears down nothing, and RETURNS. What it left behind is not merely a Node
// handle: a live pool holding a checked-out connection and `pg_advisory_xact_lock(hashtext(table))`
// inside an open transaction blocks every other bridge process's bootstrap on the same table, and
// nothing above the seam has a reference left to close it.
//
// Parameterized over the AWAIT the raced call is held at, not over one caller: the next such window
// is a new row here. Every row is graded on the same two invariants — at the instant `disconnect()`
// RETURNS nothing is live (sampled then, not after everything has settled, because the call it
// raced cleans up after itself a moment later and would hide the whole defect), and the raced call
// leaves the plugin fully disconnected rather than half-initialised.

interface PoolShape {
  ended: boolean;
  outstanding: number;
}
interface ClientShape {
  ended: boolean;
}

const state = vi.hoisted(() => ({
  pools: [] as PoolShape[],
  clients: [] as ClientShape[],
  /** The await the next arrival must park at, or null; consumed by the first one to reach it. */
  holdAt: null as string | null,
  reached: false,
  release: null as null | (() => void),
  gate: null as null | Promise<void>,
}));

vi.mock('pg', async () => {
  const { FakeEmitter, fakePool } = await import('./fake-pg.js');

  const maybeHold = async (at: string): Promise<void> => {
    if (state.holdAt !== at) return;
    state.holdAt = null;
    state.reached = true;
    await state.gate;
  };

  const answer = async (sql: string): Promise<{ rows: unknown[] }> => {
    if (/RETURNING seq/.test(sql)) return { rows: [{ seq: '1' }] };
    if (/MAX\(seq\)/.test(sql)) return { rows: [{ max: '0' }] };
    return { rows: [] };
  };

  const checkout = async (): Promise<{
    query: (sql?: string) => Promise<{ rows: unknown[] }>;
    release: () => void;
  }> => {
    await maybeHold('the pool checkout');
    return {
      query: async (sql = '') => {
        if (/pg_advisory_xact_lock/.test(sql)) {
          await maybeHold('the bootstrap advisory lock');
          await maybeHold('the write lock');
        }
        return answer(sql);
      },
      release: () => undefined,
    };
  };

  class MockClient extends FakeEmitter implements ClientShape {
    ended = false;
    constructor() {
      super();
      state.clients.push(this);
    }
    async connect(): Promise<void> {
      await maybeHold('the listener socket');
    }
    async query(sql: string): Promise<{ rows: unknown[] }> {
      if (/^LISTEN /.test(sql)) await maybeHold('the LISTEN');
      return { rows: [] };
    }
    async end(): Promise<void> {
      this.ended = true;
    }
  }

  return {
    Pool: vi.fn(() => {
      const pool = fakePool((sql) => answer(sql), checkout);
      state.pools.push(pool);
      return pool;
    }),
    Client: MockClient,
  };
});

const URL = 'postgres://app:s3cret@db.example.com:5432/prod';
const CONFIG = { url: URL };
const TOPIC = asTopic('raced');

interface Priv {
  pool?: unknown;
  listener?: unknown;
  starting: Set<unknown>;
  subs: Map<string, unknown>;
  subscribing: Map<string, unknown>;
  listens: Map<string, unknown>;
  waiters: Map<string, unknown>;
  pendingAborts: Set<unknown>;
}

interface Race {
  name: string;
  /** The await inside the plugin this row holds the raced call at. */
  at: string;
  /** A completed lifecycle step this row races from; rows that race `connect` itself have none. */
  setUp?: (plugin: PostgresPlugin) => Promise<unknown>;
  call: (plugin: PostgresPlugin) => Promise<unknown>;
  /** Whether the raced call MUST report failure: a resolve tells its caller "it is set up". */
  mustReject: boolean;
}

const connected = (plugin: PostgresPlugin): Promise<void> => plugin.connect(CONFIG);

const ROWS: Race[] = [
  {
    name: 'connect(), parked on the bootstrap pool checkout',
    at: 'the pool checkout',
    call: (plugin) => plugin.connect(CONFIG),
    mustReject: true,
  },
  {
    name: 'connect(), parked on the bootstrap advisory lock',
    at: 'the bootstrap advisory lock',
    call: (plugin) => plugin.connect(CONFIG),
    mustReject: true,
  },
  {
    name: 'subscribe(), parked on the listener socket coming up',
    at: 'the listener socket',
    setUp: connected,
    call: (plugin) => plugin.subscribe(TOPIC, () => undefined),
    mustReject: true,
  },
  {
    name: 'subscribe(), parked on the LISTEN',
    at: 'the LISTEN',
    setUp: connected,
    call: (plugin) => plugin.subscribe(TOPIC, () => undefined),
    mustReject: true,
  },
  {
    name: 'a blocking fetchRecent(), parked on the LISTEN',
    at: 'the LISTEN',
    setUp: connected,
    call: (plugin) => plugin.fetchRecent({ topic: TOPIC, since: asCursor('0'), blockMs: 500 }),
    mustReject: false,
  },
  {
    name: 'post(), parked on the write lock',
    at: 'the write lock',
    setUp: connected,
    call: (plugin) => plugin.post(TOPIC, asHandle('u'), 'hi'),
    mustReject: false,
  },
];

async function until(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`the raced call never reached ${what}`);
    await sleep(2);
  }
}

const stillLive = (): { pools: number; clients: number; checkedOut: number } => ({
  pools: state.pools.filter((p) => !p.ended).length,
  clients: state.clients.filter((c) => !c.ended).length,
  checkedOut: state.pools.reduce((n, p) => n + p.outstanding, 0),
});

beforeEach(() => {
  state.pools.length = 0;
  state.clients.length = 0;
  state.holdAt = null;
  state.reached = false;
  state.release = null;
  state.gate = null;
});

describe('a Postgres disconnect that races a setup call still leaves nothing live', () => {
  it.each(ROWS.map((row) => [row.name, row] as const))('%s', async (_label, row) => {
    const plugin = new PostgresPlugin();
    const priv = plugin as unknown as Priv;
    state.gate = new Promise<void>((r) => {
      state.release = r;
    });
    try {
      await row.setUp?.(plugin);

      state.holdAt = row.at;
      const outcome = row.call(plugin).then(
        () => 'resolved' as const,
        (err: unknown) => err as Error,
      );
      await until(() => state.reached, row.at);

      // Sampled at the instant disconnect() settles: a resource it never ended is torn down by the
      // raced call a moment later, so a snapshot taken any later grades nothing.
      const teardown = plugin.disconnect().then(stillLive);
      await sleep(50);
      state.release?.();
      expect(await teardown, `disconnect() returned while ${row.at} still held something live`).toEqual(
        { pools: 0, clients: 0, checkedOut: 0 },
      );

      const settled = await outcome;
      if (row.mustReject) {
        expect(settled, 'the raced call reported success after disconnect() had returned').toBeInstanceOf(
          Error,
        );
      }
      expect(priv.pool, 'the raced call published a pool after disconnect()').toBeUndefined();
      expect(priv.listener, 'the raced call adopted a listener after disconnect()').toBeUndefined();
      expect(stillLive(), 'the raced call left something running after disconnect()').toEqual({
        pools: 0,
        clients: 0,
        checkedOut: 0,
      });
      expect(
        {
          starting: priv.starting.size,
          subs: priv.subs.size,
          subscribing: priv.subscribing.size,
          listens: priv.listens.size,
          waiters: priv.waiters.size,
          pendingAborts: priv.pendingAborts.size,
        },
        'a registry survived the teardown',
      ).toEqual({ starting: 0, subs: 0, subscribing: 0, listens: 0, waiters: 0, pendingAborts: 0 });

      // Nothing above the seam can tell a half-initialised plugin from a disconnected one except by
      // driving it: a supervisor's next act after disconnect() is connect().
      await plugin.connect(CONFIG);
    } finally {
      state.release?.();
      await plugin.disconnect().catch(() => undefined);
    }
  }, 20000);
});
