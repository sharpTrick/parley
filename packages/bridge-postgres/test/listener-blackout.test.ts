import { asCursor, asTopic } from '@sharptrick/parley-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';

// The listener connection is memoized, and a drop starts a backoff loop that replaces it. Neither the
// `error` nor the `end` handler clears the memo, so for the length of that blackout `ensureListener()`
// hands back the CLOSED Client — and a seam call issued in the window fails with whatever
// node-postgres says ('Client has encountered a connection error and is not queryable'), naming
// neither this plugin nor the topic. core's push loop rethrows anything that is not a
// NoSuchTopicError, so that string is what stops the bridge coming up.
//
// The blackout itself is by design — it is the window the backoff loop exists to cover, and a retry
// after it lands succeeds. What must not happen is a raw driver string escaping the seam, so the
// property is graded for every seam call that touches the listener, in and out of the window.

const state = vi.hoisted(() => ({
  clients: [] as MockShape[],
  dead: new Set<MockShape>(),
  /** How many further `connect()`s on a replacement listener must fail. */
  connectFailures: 0,
  established: [] as string[],
}));

interface MockShape {
  emit: (event: string, arg?: unknown) => void;
}

vi.mock('pg', async () => {
  const { FakeEmitter, fakePool, servePool } = await import('./fake-pg.js');

  class MockClient extends FakeEmitter implements MockShape {
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
      if (listen !== null) state.established.push(listen[1] as string);
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }

  return {
    Pool: vi.fn(() => fakePool(async (sql, values) => ({ rows: servePool([], sql, values) ?? [] }))),
    Client: MockClient,
  };
});

const URL = 'postgres://app:s3cret@db.example.com:5432/prod';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The plugin's own backoff between listener reconnect attempts. */
const RECONNECT_DELAY_MS = 500;

type Call = 'subscribe a new topic' | 'blocking fetchRecent' | 'subscribe the same topic again';
type Window =
  | 'during the blackout'
  | 'during a blackout the reconnect cannot end'
  | 'after the reconnect has landed';

const CALLS: Call[] = [
  'subscribe a new topic',
  'blocking fetchRecent',
  'subscribe the same topic again',
];
const WINDOWS: Window[] = [
  'during the blackout',
  'during a blackout the reconnect cannot end',
  'after the reconnect has landed',
];

const CELLS = CALLS.flatMap((call) => WINDOWS.map((window) => ({ call, window })));

beforeEach(() => {
  state.clients = [];
  state.dead = new Set();
  state.connectFailures = 0;
  state.established = [];
});

describe('a seam call across a listener blackout never surfaces a raw driver error', () => {
  it.each(CELLS.map((c) => [`${c.call}, ${c.window}`, c] as const))(
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

        const invoke = async (): Promise<void> => {
          if (cell.call === 'blocking fetchRecent') {
            await plugin.fetchRecent({ topic: target, since: asCursor('0'), blockMs: 200 });
            return;
          }
          await plugin.subscribe(target, () => undefined);
        };

        let rejection: Error | undefined;
        await invoke().catch((err: unknown) => {
          rejection = err as Error;
        });

        if (cell.window === 'after the reconnect has landed') {
          expect(rejection, 'the call failed after the listener was already replaced').toBeUndefined();
          return;
        }
        if (rejection !== undefined) {
          expect(rejection.message).toMatch(/^parley-postgres:/);
          expect(rejection.message, 'the failure must say which topic it was for').toContain(
            String(target),
          );
        }
      } finally {
        await plugin.disconnect().catch(() => undefined);
        state.connectFailures = 0;
      }
    },
    30000,
  );
});
