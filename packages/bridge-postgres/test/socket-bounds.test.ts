import { asTopic } from '@sharptrick/parley-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_WAIT_MS, PostgresPlugin } from '../src/index.js';
import { sleep } from './pg-harness.js';

// The behavioural half of this lives in silent-peer.test.ts, against real sockets. This file grades
// the same class one level down and for EVERY socket rather than the ones a case happens to
// exercise: whatever the plugin opens, it hands the driver a finite ceiling on the dial and on a
// statement. Both failures this bounds are invisible to the driver — a peer that completes the TCP
// handshake and then never speaks, and one that stops answering mid-session — so pg waits forever
// by default and a connection opened without these is a wait nothing ends.
//
// It is graded off what `pg` is CONSTRUCTED with, not off where the constants live, so moving or
// renaming them changes nothing here and a connection added by a later path is covered the moment
// it is opened.

interface Opened {
  kind: 'Pool' | 'Client';
  config: Record<string, unknown>;
  /** The driver object itself, so a case can drop the socket the way the network would. */
  socket: { emit: (event: string) => boolean };
}

const state = vi.hoisted(() => ({ opened: [] as Opened[] }));

vi.mock('pg', async () => {
  const { FakeEmitter, fakePool } = await import('./fake-pg.js');

  class MockClient extends FakeEmitter {
    constructor(config: Record<string, unknown>) {
      super();
      state.opened.push({ kind: 'Client', config, socket: this });
    }
    async connect(): Promise<void> {}
    async query(): Promise<{ rows: unknown[] }> {
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }

  return {
    Pool: vi.fn((config: Record<string, unknown>) => {
      const pool = fakePool(async (sql) => ({ rows: /MAX\(seq\)/.test(sql) ? [{ max: '0' }] : [] }));
      state.opened.push({ kind: 'Pool', config, socket: pool });
      return pool;
    }),
    Client: MockClient,
  };
});

const URL = 'postgres://app:s3cret@db.example.com:5432/prod';

/** A finite, positive number of milliseconds — `false`, `0` and `undefined` all mean "forever". */
function bounded(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

beforeEach(() => {
  state.opened.length = 0;
});

/**
 * Every socket the plugin opens across a whole lifecycle, including the one the backoff reconnect
 * dials — so a path that skipped the bounds would have to be a path no lifecycle reaches.
 */
async function openEverySocket(): Promise<Opened[]> {
  const plugin = new PostgresPlugin();
  await plugin.connect({ url: URL, table_name: 'parley_bounds' });
  try {
    await plugin.subscribe(asTopic('bounded'), () => undefined);
    const dialled = state.opened.filter((o) => o.kind === 'Client').length;
    // Drop the listener the way the network would, so the backoff reconnect dials a replacement.
    (state.opened.filter((o) => o.kind === 'Client').at(-1) as Opened).socket.emit('end');
    const deadline = Date.now() + 5000;
    while (state.opened.filter((o) => o.kind === 'Client').length === dialled) {
      if (Date.now() > deadline) throw new Error('the backoff reconnect never dialled a replacement');
      await sleep(10);
    }
    return [...state.opened];
  } finally {
    await plugin.disconnect().catch(() => undefined);
  }
}

describe('no socket this plugin opens is left unbounded', () => {
  it('a lifecycle really does open a pool and a listener, so the rules below are not vacuous', async () => {
    const opened = await openEverySocket();
    expect(opened.map((o) => o.kind)).toContain('Pool');
    expect(opened.map((o) => o.kind)).toContain('Client');
  });

  it('every socket carries a ceiling on the dial and on a statement', async () => {
    const opened = await openEverySocket();
    const unbounded = opened.filter(
      (o) => !bounded(o.config['connectionTimeoutMillis']) || !bounded(o.config['query_timeout']),
    );
    expect(
      unbounded.map((o) => o.kind),
      'a peer that accepts the socket and then never speaks makes this connection wait forever',
    ).toEqual([]);
  });

  it('every socket asks the OS to surface a peer that vanished without a FIN', async () => {
    const opened = await openEverySocket();
    const silent = opened.filter((o) => o.config['keepAlive'] !== true);
    expect(silent.map((o) => o.kind), 'a dead peer stays indistinguishable from an idle one').toEqual(
      [],
    );
  });

  // The pool's connect ceiling is not only a dial bound: pg-pool applies it to the whole acquire,
  // including the queue behind `pool_size` busy clients. A `post()` sitting out its documented
  // server-side lock wait holds a checkout for LOCK_WAIT_MS, so a ceiling at or under that turns
  // ordinary lock contention into acquire failures for every reader queued behind it — a fix for
  // the hang that breaks the wait it was supposed to leave alone.
  it('the pool ceilings leave room for the lock wait they must not pre-empt', async () => {
    const pools = (await openEverySocket()).filter((o) => o.kind === 'Pool');
    const tooTight = pools.filter(
      (o) =>
        Number(o.config['connectionTimeoutMillis']) <= LOCK_WAIT_MS ||
        Number(o.config['query_timeout']) <= LOCK_WAIT_MS,
    );
    expect(
      tooTight.length,
      'a reader queued behind a post parked on its lock would fail instead of waiting',
    ).toBe(0);
  });
});
