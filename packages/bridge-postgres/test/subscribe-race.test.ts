import { asCursor, asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { sleep } from './pg-harness.js';

// `subscribe` looks up the topic's existing registration and then, several awaits later, installs a
// new one. If that check-then-act is separated by an await, k concurrent subscribes to one topic all
// miss the check and the last writer wins: every earlier handler is dropped forever and the
// channel's LISTEN refcount is left inflated. Sequential subscribes cannot see it, so this matrix
// drives the concurrent shape directly, at several k and with the awaits made slow enough that the
// window is always open.

const state = vi.hoisted(() => ({
  /** Delay applied to the tail read and the LISTEN, so the registration window is wide. */
  slowMs: 0,
  clients: [] as MockClientShape[],
  /**
   * The table, per topic. Rows STAY here: the cursor predicate and the ORDER BY in the SQL decide
   * what comes back, exactly as the server decides it.
   */
  rows: new Map<string, Record<string, unknown>[]>(),
  listenCalls: [] as string[],
  /** When true, `query('LISTEN …')` rejects on the listener connection. */
  listenRejects: false,
  /** Extra delay on the tail read and on the LISTEN, to widen the arming window on its own. */
  tailMs: 0,
  listenMs: 0,
  /** Fired the instant the tail read has been served — the arming window is now open. */
  onTailRead: null as (() => void) | null,
  /** Fired when a LISTEN reaches the connection, before its delay, and once it has succeeded. */
  onListenAttempt: null as (() => void) | null,
  onListenEstablished: null as (() => void) | null,
  /**
   * Fired the moment a drain read is about to come back empty — the instant a row committed
   * elsewhere would land while the drain believes it has caught up.
   */
  onDrainEmpty: null as (() => void) | null,
}));

interface MockClientShape {
  emit: (event: string, arg?: unknown) => boolean;
}


vi.mock('pg', async () => {
  const { FakeEmitter, fakePool, servePool } = await import('./fake-pg.js');

  class MockClient extends FakeEmitter implements MockClientShape {
    constructor() {
      super();
      state.clients.push(this);
    }
    async connect(): Promise<void> {
      if (state.slowMs > 0) await sleep(state.slowMs);
    }
    async query(sql: string): Promise<{ rows: unknown[] }> {
      const listen = /^LISTEN "(.+)"$/.exec(sql);
      if (listen !== null) {
        state.listenCalls.push(listen[1] as string);
        state.onListenAttempt?.();
        if (state.listenMs > 0) await sleep(state.listenMs);
        if (state.slowMs > 0) await sleep(state.slowMs);
        if (state.listenRejects) throw new Error('LISTEN failed (mock)');
        state.onListenEstablished?.();
      }
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }

  return {
    Pool: vi.fn(() =>
      fakePool(async (sql, values) => {
        if (/MAX\(seq\)/.test(sql)) {
          if (state.slowMs > 0) await sleep(state.slowMs);
          if (state.tailMs > 0) await sleep(state.tailMs);
        }
        const served = servePool(state.rows.get(String(values[0])) ?? [], sql, values);
        if (/MAX\(seq\)/.test(sql)) state.onTailRead?.();
        if (served !== undefined && served.length === 0 && state.onDrainEmpty !== null) {
          const fire = state.onDrainEmpty;
          state.onDrainEmpty = null;
          fire();
        }
        return { rows: served ?? [] };
      }),
    ),
    Client: MockClient,
  };
});

const REAL_URL = 'postgres://app:s3cret@db.example.com:5432/prod';
const DRAIN_BATCH = 512;

function rows(topic: string, count: number, from = 1): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: String(from + i),
    topic,
    sender: asHandle('u'),
    content: `m${i}`,
    ts: new Date().toISOString(),
    in_reply_to: null,
  }));
}

beforeEach(() => {
  state.slowMs = 0;
  state.clients.length = 0;
  state.listenCalls.length = 0;
  state.listenRejects = false;
  state.tailMs = 0;
  state.listenMs = 0;
  state.onTailRead = null;
  state.onListenAttempt = null;
  state.onListenEstablished = null;
  state.rows.clear();
  state.onDrainEmpty = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

interface RaceCell {
  k: number;
  topics: number;
  slowMs: number;
}

const RACE_CELLS: RaceCell[] = [2, 3, 5].flatMap((k) =>
  [1, 2].flatMap((topics) => [0, 20].map((slowMs) => ({ k, topics, slowMs }))),
);

describe('concurrent subscribe registration', () => {
  it.each(
    RACE_CELLS.map(
      (c) => [`${c.k} concurrent, ${c.topics} topic(s), ${c.slowMs}ms window`, c] as const,
    ),
  )('%s: every handler is registered and fed exactly once', async (_label, cell) => {
    state.slowMs = cell.slowMs;
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });

    const topics = Array.from({ length: cell.topics }, (_, i) => `t${i}`);
    const seen: Message[][] = [];
    await Promise.all(
      Array.from({ length: cell.k }, (_, i) => {
        const box: Message[] = [];
        seen.push(box);
        return plugin.subscribe(asTopic(topics[i % cell.topics] as string), (m) => box.push(m));
      }),
    );

    const priv = plugin as unknown as {
      subs: Map<string, { handlers: unknown[] }>;
      listens: Map<string, { refs: number }>;
      subscribing: Map<string, unknown>;
    };
    expect(priv.subs.size, 'one registration per topic').toBe(cell.topics);
    expect(priv.subscribing.size, 'in-flight registry leaked').toBe(0);
    expect([...priv.subs.values()].reduce((n, s) => n + s.handlers.length, 0)).toBe(cell.k);
    expect([...priv.listens.values()].map((l) => l.refs)).toEqual(
      Array.from({ length: cell.topics }, () => 1),
    );
    expect(state.listenCalls.length, 'one LISTEN per channel').toBe(cell.topics);

    state.slowMs = 0;
    for (const [channel, sub] of priv.subs.entries()) {
      const topic = (sub as unknown as { topic: string }).topic;
      state.rows.set(topic, rows(topic, 1));
      state.clients[0]?.emit('notification', { channel });
    }
    await sleep(80);

    for (const box of seen) expect(box.map((m) => m.content)).toEqual(['m0']);

    await plugin.disconnect();
  }, 15000);

  it('a concurrent subscribe whose shared LISTEN fails rejects for every caller and registers nothing', async () => {
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });
    state.listenRejects = true;

    const results = await Promise.allSettled([
      plugin.subscribe(asTopic('t'), () => undefined),
      plugin.subscribe(asTopic('t'), () => undefined),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);

    const priv = plugin as unknown as {
      subs: Map<string, unknown>;
      subscribing: Map<string, unknown>;
      listens: Map<string, unknown>;
    };
    expect(priv.subs.size).toBe(0);
    expect(priv.subscribing.size).toBe(0);
    expect(priv.listens.size).toBe(0);

    await plugin.disconnect();
  });
});

describe('drain honours the server-side batch cap', () => {
  it.each([0, 1, DRAIN_BATCH - 1, DRAIN_BATCH, DRAIN_BATCH + 1, 2 * DRAIN_BATCH + 3])(
    'delivers %i queued row(s) completely, in order, exactly once',
    async (count) => {
      const plugin = new PostgresPlugin();
      await plugin.connect({ url: REAL_URL });

      const got: Message[] = [];
      const topic = 'batch';
      await plugin.subscribe(asTopic(topic), (m) => got.push(m));
      const channel = [
        ...(plugin as unknown as { subs: Map<string, unknown> }).subs.keys(),
      ][0] as string;

      state.rows.set(topic, rows(topic, count));
      state.clients[0]?.emit('notification', { channel });
      await sleep(120);

      expect(got.map((m) => m.content)).toEqual(
        Array.from({ length: count }, (_, i) => `m${i}`),
      );
      expect(new Set(got.map((m) => m.backendMsgId)).size, 'duplicate delivery').toBe(got.length);

      await plugin.disconnect();
    },
    15000,
  );

  // The drain re-queries until empty, so almost every mid-drain arrival is swept up by the loop
  // itself. The one that isn't is a row that commits in the instant the drain's last read comes
  // back empty: its NOTIFY lands while `draining` is still set, so the notification is dropped and
  // only the coalescing flag makes the loop run once more. Nothing else in the suite reaches that
  // instant, so it is driven directly here at each batch boundary.
  it.each([1, DRAIN_BATCH, DRAIN_BATCH + 1])(
    'a row committing in the instant a %i-row drain reads empty is still delivered, with no second NOTIFY',
    async (count) => {
      const plugin = new PostgresPlugin();
      await plugin.connect({ url: REAL_URL });

      const got: Message[] = [];
      const topic = 'coalesce';
      await plugin.subscribe(asTopic(topic), (m) => got.push(m));
      const channel = [
        ...(plugin as unknown as { subs: Map<string, unknown> }).subs.keys(),
      ][0] as string;

      state.rows.set(topic, rows(topic, count));
      state.onDrainEmpty = () => {
        state.rows.get(topic)?.push(...rows(topic, 1, count + 1));
        state.clients[0]?.emit('notification', { channel });
      };
      state.clients[0]?.emit('notification', { channel });
      await sleep(200);

      expect(state.onDrainEmpty, 'the mid-drain arrival never happened').toBeNull();
      expect(got.map((m) => m.content)).toEqual([
        ...Array.from({ length: count }, (_, i) => `m${i}`),
        'm0',
      ]);
      expect(new Set(got.map((m) => m.backendMsgId)).size, 'duplicate delivery').toBe(got.length);

      await plugin.disconnect();
    },
    15000,
  );
});

// `subscribe` reads the topic's tail, LISTENs, registers, and only THEN drains from that tail. A row
// that becomes visible anywhere between the tail read and the registration rang a doorbell nobody
// was listening for yet, so the post-registration drain is the only thing that can ever deliver it —
// nothing re-triggers one until the NEXT post to that topic. These cells widen the arming window and
// NEVER ring the doorbell, so a cell can only pass if that drain ran. The pre-tail-read cell is the
// other side: push does not replay history, so a row already visible must NOT arrive.

type Landing =
  | 'before the tail read'
  | 'after the tail read'
  | 'during the LISTEN'
  | 'once the LISTEN is established';

const LANDINGS: Landing[] = [
  'before the tail read',
  'after the tail read',
  'during the LISTEN',
  'once the LISTEN is established',
];

const ARMING_WINDOW_MS = 150;

interface ArmingCell {
  landing: Landing;
  warm: boolean;
}

const ARMING_CELLS: ArmingCell[] = LANDINGS.flatMap((landing) =>
  [false, true].map((warm) => ({ landing, warm })),
);

/** Make the row visible once, and report whether the moment this cell aimed at ever arrived. */
function landOnce(topic: string): { land: () => void; landed: () => boolean } {
  let fired = false;
  return {
    land: () => {
      if (fired) return;
      fired = true;
      state.rows.set(topic, rows(topic, 1));
    },
    landed: () => fired,
  };
}

describe('a row landing while subscribe arms the live path', () => {
  it.each(
    ARMING_CELLS.map(
      (c) =>
        [
          `${c.landing}, ${c.warm ? 'listener already open for another topic' : 'cold listener'}`,
          c,
        ] as const,
    ),
  )('%s', async (_label, cell) => {
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });
    if (cell.warm) await plugin.subscribe(asTopic('elsewhere'), () => undefined);

    const topic = 'arming';
    const { land, landed } = landOnce(topic);
    state.tailMs = ARMING_WINDOW_MS;
    state.listenMs = ARMING_WINDOW_MS;
    if (cell.landing === 'before the tail read') land();
    else if (cell.landing === 'after the tail read') state.onTailRead = land;
    else if (cell.landing === 'during the LISTEN') state.onListenAttempt = land;
    else state.onListenEstablished = land;

    const got: Message[] = [];
    await plugin.subscribe(asTopic(topic), (m) => got.push(m));
    await sleep(120);

    expect(landed(), 'the moment this cell aims at never arrived, so it proves nothing').toBe(true);
    expect(state.listenCalls, 'the channel was never LISTENed').toContain(
      [...(plugin as unknown as { subs: Map<string, unknown> }).subs.keys()].at(-1),
    );
    expect(got.map((m) => m.content)).toEqual(
      cell.landing === 'before the tail read' ? [] : ['m0'],
    );
    expect(new Set(got.map((m) => m.backendMsgId)).size, 'duplicate delivery').toBe(got.length);

    await plugin.disconnect();
  }, 15000);

  it('a subscribe piggybacking an established LISTEN still drains its arming window', async () => {
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: REAL_URL });
    const topic = 'piggyback';

    const parked = plugin.fetchRecent({
      topic: asTopic(topic),
      since: asCursor('0'),
      blockMs: 3000,
    });
    await sleep(40);
    const listensBefore = state.listenCalls.length;

    const { land, landed } = landOnce(topic);
    state.tailMs = ARMING_WINDOW_MS;
    state.onTailRead = land;

    const got: Message[] = [];
    await plugin.subscribe(asTopic(topic), (m) => got.push(m));
    await sleep(120);

    expect(landed(), 'the tail read never happened, so this case proves nothing').toBe(true);
    expect(state.listenCalls.length, 'the waiter’s LISTEN was not reused').toBe(listensBefore);
    expect(got.map((m) => m.content)).toEqual(['m0']);

    await plugin.disconnect();
    await parked;
  }, 15000);
});
