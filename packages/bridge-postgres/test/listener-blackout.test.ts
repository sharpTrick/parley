import { asCursor, asTopic, type FetchRecentResult, type Message } from '@sharptrick/parley-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { channelFor } from '../src/schema.js';

// A dropped listener connection starts a backoff reconnect, and every seam call issued in that
// window has to be answered from the reconnect rather than from the socket that just closed. Two
// separate properties live here, and each cell declares which one it is graded against:
//
//   - a call that CAN fail (a fresh subscribe, once the reconnect has exhausted its budget) fails
//     with a message naming this plugin and the topic. core's push loop rethrows anything that is
//     not a NoSuchTopicError, so a raw driver string ('Client has encountered a connection error
//     and is not queryable') is what would stop the whole bridge coming up.
//   - a call that MUST NOT fail keeps its guarantee, which is asserted as the observable
//     consequence and not as the absence of a throw: a subscribe's live path really delivers once
//     the reconnect lands, and a blocking fetch really comes back with an empty page inside its
//     own block budget rather than parking on the dead connection.
//
// Every cell asserts its declared outcome unconditionally, so a cell that changes arm — a call
// that starts failing, or one that stops — fails here instead of quietly grading nothing.

const state = vi.hoisted(() => ({
  clients: [] as MockShape[],
  dead: new Set<MockShape>(),
  /** How many further `connect()`s on a replacement listener must fail. */
  connectFailures: 0,
  /** The table, per topic — what a drain after the reconnect must actually come back with. */
  rows: new Map<string, Record<string, unknown>[]>(),
}));

interface MockShape {
  listened: string[];
  emit: (event: string, arg?: unknown) => boolean;
}

vi.mock('pg', async () => {
  const { FakeEmitter, fakePool, servePool } = await import('./fake-pg.js');

  class MockClient extends FakeEmitter implements MockShape {
    readonly listened: string[] = [];
    constructor() {
      super();
      state.clients.push(this);
    }
    async connect(): Promise<void> {
      if (state.connectFailures > 0) {
        state.connectFailures--;
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      }
    }
    async query(sql: string): Promise<{ rows: unknown[] }> {
      if (state.dead.has(this)) {
        throw new Error('Client has encountered a connection error and is not queryable');
      }
      const listen = /^LISTEN "(.+)"$/.exec(sql);
      if (listen !== null) this.listened.push(listen[1] as string);
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }

  return {
    Pool: vi.fn(() =>
      fakePool(async (sql, values) => ({
        rows: servePool(state.rows.get(String(values[0])) ?? [], sql, values) ?? [],
      })),
    ),
    Client: MockClient,
  };
});

const URL = 'postgres://app:s3cret@db.example.com:5432/prod';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The plugin's own backoff between listener reconnect attempts. */
const RECONNECT_DELAY_MS = 500;
const BLOCK_MS = 200;

async function until(pred: () => boolean, budgetMs = 5000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!pred() && Date.now() < deadline) await sleep(5);
}

type Call = 'subscribe a new topic' | 'blocking fetchRecent' | 'subscribe the same topic again';
type Window =
  | 'during the blackout'
  | 'during a blackout the reconnect cannot end'
  | 'after the reconnect has landed';
type Outcome = 'rejects' | 'resolves';

const WINDOWS: Window[] = [
  'during the blackout',
  'during a blackout the reconnect cannot end',
  'after the reconnect has landed',
];

/**
 * The arm each cell is graded against. A fresh subscribe is the only call that can fail: it needs
 * a LISTEN, so it waits for the reconnect and gives up only when that wait runs out. A repeat
 * subscribe is a registration on a channel already held, and a blocking fetch degrades to core's
 * poll fallback — neither may surface the outage to the caller.
 */
const EXPECTS: Record<Call, Record<Window, Outcome>> = {
  'subscribe a new topic': {
    'during the blackout': 'resolves',
    'during a blackout the reconnect cannot end': 'rejects',
    'after the reconnect has landed': 'resolves',
  },
  'blocking fetchRecent': {
    'during the blackout': 'resolves',
    'during a blackout the reconnect cannot end': 'resolves',
    'after the reconnect has landed': 'resolves',
  },
  'subscribe the same topic again': {
    'during the blackout': 'resolves',
    'during a blackout the reconnect cannot end': 'resolves',
    'after the reconnect has landed': 'resolves',
  },
};

const CELLS = (Object.keys(EXPECTS) as Call[]).flatMap((call) =>
  WINDOWS.map((window) => ({ call, window, expects: EXPECTS[call][window] })),
);

beforeEach(() => {
  state.clients = [];
  state.dead = new Set();
  state.connectFailures = 0;
  state.rows.clear();
});

describe('a seam call across a listener blackout keeps its declared outcome', () => {
  it.each(CELLS.map((c) => [`${c.call}, ${c.window} (${c.expects})`, c] as const))(
    '%s',
    async (_label, cell) => {
      const subscribed = asTopic('already-subscribed');
      const fresh = asTopic('brand-new');
      const target = cell.call === 'subscribe the same topic again' ? subscribed : fresh;
      const plugin = new PostgresPlugin();
      await plugin.connect({ url: URL, table_name: 'parley_bo' });
      try {
        await plugin.subscribe(subscribed, () => undefined);
        const listener = state.clients.at(-1) as MockShape;

        state.dead.add(listener);
        if (cell.window === 'during a blackout the reconnect cannot end') {
          state.connectFailures = Number.MAX_SAFE_INTEGER;
        }
        listener.emit('end');

        if (cell.window === 'after the reconnect has landed') {
          await sleep(RECONNECT_DELAY_MS * 2 + 200);
        }

        const got: Message[] = [];
        const started = Date.now();
        let rejection: Error | undefined;
        let page: FetchRecentResult | undefined;
        await (cell.call === 'blocking fetchRecent'
          ? plugin.fetchRecent({ topic: target, since: asCursor('0'), blockMs: BLOCK_MS })
          : plugin.subscribe(target, (m) => got.push(m))
        ).then(
          (result) => {
            page = result ?? undefined;
          },
          (err: unknown) => {
            rejection = err as Error;
          },
        );
        const elapsedMs = Date.now() - started;

        if (cell.expects === 'rejects') {
          expect(rejection, 'this call is supposed to fail in this window').toBeDefined();
          expect((rejection as Error).message).toMatch(/^parley-postgres:/);
          expect(
            (rejection as Error).message,
            'the failure must say which topic it was for',
          ).toContain(String(target));
          return;
        }

        expect(rejection, 'this call is supposed to survive this window').toBeUndefined();

        if (cell.call === 'blocking fetchRecent') {
          // Not merely "it did not throw": the fetch has to come back with a page, inside its own
          // block budget, rather than parking on a connection that is never coming back.
          expect((page as FetchRecentResult).messages).toEqual([]);
          expect(String((page as FetchRecentResult).nextCursor)).toBe('0');
          expect(elapsedMs, 'the fetch outlived its own block budget').toBeLessThan(BLOCK_MS + 1500);
          return;
        }

        // A subscribe that resolved has promised a live path. Let the reconnect land and prove it
        // delivers — a registration whose LISTEN never happens is push silently dead for the topic.
        state.connectFailures = 0;
        const channel = channelFor(target);
        await until(() => state.clients.some((c) => !state.dead.has(c) && c.listened.includes(channel)));
        const live = state.clients.find((c) => !state.dead.has(c) && c.listened.includes(channel));
        expect(live, 'the reconnect never re-LISTENed the subscribed topic').toBeDefined();

        state.rows.set(String(target), [
          {
            seq: '1',
            topic: String(target),
            sender: 'u',
            content: 'after-blackout',
            ts: new Date().toISOString(),
            in_reply_to: null,
          },
        ]);
        (live as MockShape).emit('notification', { channel });
        await until(() => got.length > 0, 2000);
        expect(got.map((m) => m.content), 'push is dead on the subscribed topic').toEqual([
          'after-blackout',
        ]);
      } finally {
        await plugin.disconnect().catch(() => undefined);
        state.connectFailures = 0;
      }
    },
    30000,
  );
});
