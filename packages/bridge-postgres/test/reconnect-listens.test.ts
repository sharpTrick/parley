import { asCursor, asTopic, type Topic } from '@sharptrick/parley-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { channelFor } from '../src/schema.js';
import { sleep } from './pg-harness.js';

// waiters.test.ts pins that the CONNECTION's LISTEN-minus-UNLISTEN set is empty once no participant
// needs a channel — but only on the paths where one connection serves the whole story. A reconnect
// splits that: the replacement is issued the LISTENs while the release path is still addressed
// elsewhere, and a blockMs expiring inside that window drops the channel from the plugin's
// bookkeeping with the server-side registration already installed on the new socket. Nothing is
// lost, which is why it is invisible from the seam — the process is simply woken, forever, for
// every future post to a topic no subscription and no waiter is interested in, with no entry left
// anywhere to undo it.
//
// So the property is asserted on the REPLACEMENT connection, at the two moments it can differ from
// the plugin's own belief, across how many channels the reconnect has to carry, whether a
// subscription still needs the released one, and where in the loop the release lands.

const state = vi.hoisted(() => ({
  clients: [] as MockShape[],
  dead: new Set<MockShape>(),
  listenDelayMs: 0,
}));

interface MockShape {
  listened: string[];
  unlistened: string[];
  emit: (event: string, arg?: unknown) => boolean;
}

vi.mock('pg', async () => {
  const { FakeEmitter, fakePool, servePool } = await import('./fake-pg.js');

  class MockClient extends FakeEmitter implements MockShape {
    readonly listened: string[] = [];
    readonly unlistened: string[] = [];
    constructor() {
      super();
      state.clients.push(this);
    }
    async connect(): Promise<void> {}
    async query(sql: string): Promise<{ rows: unknown[] }> {
      if (state.dead.has(this)) throw new Error('Client has encountered a connection error');
      const unlisten = /^UNLISTEN "(.+)"$/.exec(sql);
      if (unlisten !== null) {
        this.unlistened.push(unlisten[1] as string);
        return { rows: [] };
      }
      const listen = /^LISTEN "(.+)"$/.exec(sql);
      if (listen !== null) {
        if (state.listenDelayMs > 0) {
          await new Promise((r) => setTimeout(r, state.listenDelayMs));
        }
        this.listened.push(listen[1] as string);
      }
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
/** The plugin's own backoff before the first reconnect attempt. */
const RECONNECT_DELAY_MS = 500;
/** How long each re-LISTEN takes on the replacement, so the loop is wide enough to land inside. */
const LISTEN_DELAY_MS = 200;
/** Margin between the last assertion point and the waiters that had to stay parked for it. */
const HOLD_MARGIN_MS = 300;
/** Gap between the waiters starting and the connection dropping. */
const ARM_MS = 80;

/** LISTEN minus UNLISTEN, as ONE connection observed it — the only view a server-side leak is in. */
function observed(client: MockShape): string[] {
  const net = new Map<string, number>();
  for (const channel of client.listened) net.set(channel, (net.get(channel) ?? 0) + 1);
  for (const channel of client.unlistened) net.set(channel, (net.get(channel) ?? 0) - 1);
  return [...net.entries()]
    .filter(([, n]) => n > 0)
    .map(([channel]) => channel)
    .sort();
}

type Release = 'before the re-LISTEN loop' | 'inside the re-LISTEN loop' | 'after adoption';

interface Cell {
  channels: number;
  withSubscription: boolean;
  release: Release;
}

/** When the released waiter's budget must expire, measured from the connection dropping. */
function releaseAtMs(cell: Cell): number {
  switch (cell.release) {
    case 'before the re-LISTEN loop':
      return RECONNECT_DELAY_MS / 2;
    case 'inside the re-LISTEN loop':
      return RECONNECT_DELAY_MS + LISTEN_DELAY_MS * (cell.channels - 1) + LISTEN_DELAY_MS / 2;
    default:
      return RECONNECT_DELAY_MS + LISTEN_DELAY_MS * cell.channels + 200;
  }
}

/** Once the reconnect has certainly settled and the release has certainly landed. */
function settledAtMs(cell: Cell): number {
  return Math.max(releaseAtMs(cell), RECONNECT_DELAY_MS + LISTEN_DELAY_MS * cell.channels) + 500;
}

const CELLS: Cell[] = [1, 2, 3].flatMap((channels) =>
  [false, true].flatMap((withSubscription) =>
    (
      [
        'before the re-LISTEN loop',
        'inside the re-LISTEN loop',
        'after adoption',
      ] as Release[]
    ).map((release) => ({ channels, withSubscription, release })),
  ),
);

beforeEach(() => {
  state.clients = [];
  state.dead = new Set();
  state.listenDelayMs = 0;
});

describe('a reconnect leaves the replacement LISTENed for exactly what is still needed', () => {
  it.each(
    CELLS.map(
      (c) =>
        [
          `${c.channels} channel(s), ${
            c.withSubscription ? 'a subscription still holds the released one' : 'waiters only'
          }, released ${c.release}`,
          c,
        ] as const,
    ),
  )('%s', async (_label, cell) => {
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: URL, table_name: 'parley_rl' });

    const topics: Topic[] = Array.from({ length: cell.channels }, (_, i) => asTopic(`rl-${i}`));
    const channels = topics.map((t) => channelFor(t));
    const [first] = topics as [Topic];
    const released = channelFor(first);

    if (cell.withSubscription) await plugin.subscribe(first, () => undefined);

    const waits = topics.map((topic, i) =>
      plugin.fetchRecent({
        topic,
        since: asCursor('0'),
        blockMs: ARM_MS + (i === 0 ? releaseAtMs(cell) : settledAtMs(cell) + HOLD_MARGIN_MS),
      }),
    );
    await sleep(ARM_MS);

    const old = state.clients.at(-1) as MockShape;
    expect(observed(old), 'the first connection did not take every channel').toEqual(
      [...channels].sort(),
    );
    const oldIndex = state.clients.indexOf(old);

    state.listenDelayMs = LISTEN_DELAY_MS;
    state.dead.add(old);
    old.emit('end');

    await sleep(settledAtMs(cell));
    const replacement = state.clients[oldIndex + 1] as MockShape;
    expect(replacement, 'no replacement listener came up').toBeDefined();

    // The released channel is only still needed when a subscription holds it.
    const stillNeeded = cell.withSubscription
      ? [...channels]
      : channels.filter((c) => c !== released);
    expect(
      observed(replacement),
      'the replacement carries a channel no participant needs',
    ).toEqual(stillNeeded.sort());

    await Promise.all(waits);
    await sleep(100);
    expect(
      observed(replacement),
      'a channel outlived the last participant that needed it',
    ).toEqual(cell.withSubscription ? [released] : []);

    await plugin.disconnect();
  }, 30000);
});
