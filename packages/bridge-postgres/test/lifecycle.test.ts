import { asCursor, asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { sleep } from './pg-harness.js';
import { SOURCE } from './sources.js';

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


// Shared mock state, hoisted so the vi.mock factory can close over it.
const state = vi.hoisted(() => ({
  clients: [] as MockClientShape[],
  /** How many further `connect()`s on a replacement listener must fail before one lands. */
  connectFailures: 0,
  // When set, the next `new Client().connect()` parks on this deferred (used to hold a reconnect
  // candidate mid-connect while a disconnect() races it).
  connectGate: null as Deferred | null,
  // When set, the next `query('LISTEN …')` parks on this deferred — the window in which a
  // disconnect() can land between "the LISTEN was issued" and "the subscription was registered".
  listenGate: null as Deferred | null,
  /** Every channel a LISTEN was issued for, in order. */
  listenAttempts: [] as string[],
  // When true, `query('LISTEN …')` rejects (drives the failed-subscribe path).
  listenRejects: false,
  // When set, the next pooled DELETE parks on this deferred — the window between two prune
  // batches, in which a disconnect() (and a successor connect()) can land.
  deleteGate: null as Deferred | null,
  /** Every DELETE the prune loop issued, in order. */
  deletes: [] as string[],
  // The table, per topic. Rows STAY here: what a query returns is decided by the SQL's cursor
  // predicate and ORDER BY, exactly as the server decides it.
  rows: new Map<string, Record<string, unknown>[]>(),
}));

interface MockClientShape {
  ended: boolean;
  listened: string[];
  emit: (event: string, arg?: unknown) => boolean;
}

vi.mock('pg', async () => {
  const { FakeEmitter, fakePool, servePool } = await import('./fake-pg.js');

  class MockClient extends FakeEmitter implements MockClientShape {
    ended = false;
    readonly listened: string[] = [];
    constructor() {
      super();
      state.clients.push(this);
    }
    async connect(): Promise<void> {
      const gate = state.connectGate;
      if (gate !== null) {
        state.connectGate = null;
        await gate.promise;
      }
      if (state.connectFailures > 0) {
        state.connectFailures--;
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      }
    }
    async query(sql: string): Promise<{ rows: unknown[] }> {
      const listen = /^LISTEN "(.+)"$/.exec(sql);
      if (listen !== null) {
        state.listenAttempts.push(listen[1] as string);
        const gate = state.listenGate;
        if (gate !== null) {
          state.listenGate = null;
          await gate.promise;
        }
      }
      if (state.listenRejects && /LISTEN/.test(sql)) throw new Error('LISTEN failed (mock)');
      if (listen !== null) this.listened.push(listen[1] as string);
      return { rows: [] };
    }
    async end(): Promise<void> {
      this.ended = true;
    }
  }

  const poolQuery = async (
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number }> => {
    if (/^\s*DELETE/.test(sql)) {
      state.deletes.push(sql);
      const gate = state.deleteGate;
      if (gate !== null) {
        state.deleteGate = null;
        await gate.promise;
      }
      // A full batch, so the prune loop goes round again and re-reaches its teardown guard — but
      // only a few, so a loop that no longer stops is a failed assertion rather than a suite that
      // never finishes and reports nothing.
      const limit = /LIMIT (\d+)/.exec(sql);
      return { rows: [], rowCount: state.deletes.length <= 3 ? Number(limit?.[1] ?? 0) : 0 };
    }
    const served = servePool(state.rows.get(String(values[0])) ?? [], sql, values);
    return { rows: served ?? [] };
  };

  return {
    Pool: vi.fn(() => fakePool(poolQuery)),
    Client: MockClient,
  };
});

// A real DSN so the default-credential warning stays quiet.
const REAL_URL = 'postgres://app:s3cret@db.example.com:5432/prod';

beforeEach(() => {
  state.clients.length = 0;
  state.connectFailures = 0;
  state.connectGate = null;
  state.listenGate = null;
  state.listenAttempts.length = 0;
  state.listenRejects = false;
  state.deleteGate = null;
  state.deletes.length = 0;
  state.rows.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Every chore this plugin runs in the background parks on an await, and `disconnect()` can land in
// that await. `stopped` alone cannot detect it, because `connect()` sets `stopped` back to false: a
// chore that slept across a whole teardown AND restart wakes up believing it is live and publishes
// into the NEXT lifecycle's registries. The two shapes that costs are a listener connection the new
// session created being overwritten and never end()ed (a leaked socket and server backend for the
// life of the process), and a TopicSubscription surviving into the new session, where subscribe()'s
// fast path hands it back and no LISTEN is ever issued — push silently dead for that topic.
//
// So this is parameterized over every chore that can be parked here x whether a connect() follows
// the disconnect, and asserts the same two invariants in each cell: nothing the old lifecycle built
// is reachable from the plugin afterwards, and every Client ever constructed is either the current
// listener or ended.

interface Priv {
  listener?: { ended: boolean } | undefined;
  listenerPromise?: unknown;
  subs: Map<string, { handlers: unknown[] }>;
  subscribing: Map<string, unknown>;
  listens: Map<string, unknown>;
  waiters: Map<string, unknown>;
  pendingAborts: Set<unknown>;
}

function registrySizes(priv: Priv): Record<string, number> {
  return {
    subs: priv.subs.size,
    subscribing: priv.subscribing.size,
    listens: priv.listens.size,
    waiters: priv.waiters.size,
    pendingAborts: priv.pendingAborts.size,
  };
}

async function until(pred: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!pred() && Date.now() < deadline) await sleep(2);
}

type Chore =
  | 'subscribe-listen'
  | 'blocking-fetch'
  | 'reconnect-backoff'
  | 'reconnect-connect'
  | 'prune-batch';
type Next = 'disconnect' | 'disconnect+connect';

const CHORES: Chore[] = [
  'subscribe-listen',
  'blocking-fetch',
  'reconnect-backoff',
  'reconnect-connect',
  'prune-batch',
];

/**
 * A teardown guard is how a call that parked across an await asks whether it is still the live
 * lifecycle's: a comparison of a captured epoch against `this.epoch`, in either operand order and
 * whichever way round the test is written, OR a claim on the `starting` slot the call published its
 * unadopted resource into. The census below counted `epoch !== this.epoch` alone, so the three
 * guards already written as `epoch === this.epoch` were invisible to it and a new teardown-crossing
 * await in that spelling shipped with the file still green; it then counted epoch comparisons alone,
 * so `connect()`'s bootstrap await went uncounted the moment its guard changed spelling.
 */
const TEARDOWN_GUARD =
  /(?:\w+\s*[!=]==?\s*this\.epoch|this\.epoch\s*[!=]==?\s*\w+|this\.starting\.delete\()/g;

/**
 * Every form the rule has to recognise, each with a sample it must find. Keep this table beside the
 * pattern, so that a guard written in a shape the regex cannot see fails here rather than silently
 * shrinking the census to whatever spelling it happens to match.
 */
const TEARDOWN_GUARD_FORMS: [what: string, sample: string][] = [
  ['an inequality guard', 'if (this.stopped || epoch !== this.epoch) return;'],
  ['a while condition in the equality form', 'while (!this.stopped && epoch === this.epoch) {'],
  ['a do…while condition in the equality form', '} while (sub.pending && epoch === this.epoch);'],
  ['a bare statement guard', 'if (epoch === this.epoch) this.reconnecting = false;'],
  ['the comparison written with this.epoch first', 'if (this.epoch !== guardEpoch) return;'],
  ['a loose comparison', 'if (epoch != this.epoch) return;'],
  ['a claim on the in-flight slot', 'if (!this.starting.delete(pool)) throw disconnected();'],
  ['the in-flight slot released on a failure path', 'this.starting.delete(client);'],
];

/**
 * Every await in this plugin that a `disconnect()` can land in re-checks afterwards whether it is
 * still the live lifecycle's, and the table below drives one row per chore into that window. Pinned
 * by VALUE so a guard site added later is a missing row rather than silence: a new one means a new
 * await that can cross a teardown, and it needs its own row here, in teardown-races-setup.test.ts
 * (which owns the setup calls, parameterized over the await each is held at), in
 * teardown-delivery.test.ts (which owns a drain read parked at the boundary) or in
 * push-self-heal.test.ts (which owns the drain's re-drain timer).
 */
const TEARDOWN_GUARD_SITES = 18;

const CROSS_CELLS = CHORES.flatMap((chore) =>
  (['disconnect', 'disconnect+connect'] as Next[]).map((next) => ({ chore, next })),
);

describe('a chore in flight when disconnect lands never touches the next lifecycle', () => {
  it.each(TEARDOWN_GUARD_FORMS)('the census sees a guard written as %s', (_what, sample) => {
    expect(
      sample.match(TEARDOWN_GUARD),
      'this guard form is invisible to the census below',
    ).toHaveLength(1);
  });

  it('every teardown guard in the source is represented by a row above', () => {
    const sites = [...SOURCE.matchAll(TEARDOWN_GUARD)].length;
    expect(sites, 'a guard site was added or removed — give the new await a row').toBe(
      TEARDOWN_GUARD_SITES,
    );
  });

  it.each(CROSS_CELLS.map((c) => [`${c.chore}, ${c.next}`, c] as const))(
    '%s',
    async (_label, cell) => {
      const plugin = new PostgresPlugin();
      const priv = plugin as unknown as Priv;
      const topic = asTopic('t');
      const settle = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined);
      // The prune loop is what parks on a DELETE, and it only runs when retention is configured.
      await plugin.connect(
        cell.chore === 'prune-batch' ? { url: REAL_URL, retention_days: 1 } : { url: REAL_URL },
      );

      const pending: Promise<unknown>[] = [];
      const settledAt: number[] = [];
      const timed = (p: Promise<unknown>): Promise<unknown> =>
        settle(p).then((v) => {
          settledAt.push(Date.now());
          return v;
        });
      let release: (() => void) | undefined;

      if (cell.chore === 'prune-batch') {
        const gate = deferred();
        state.deleteGate = gate;
        release = gate.resolve;
        await until(() => state.deletes.length > 0);
      } else if (cell.chore === 'subscribe-listen' || cell.chore === 'blocking-fetch') {
        const gate = deferred();
        state.listenGate = gate;
        release = gate.resolve;
        pending.push(
          timed(
            cell.chore === 'subscribe-listen'
              ? plugin.subscribe(topic, () => undefined)
              : plugin.fetchRecent({ topic, since: asCursor('0'), blockMs: 4000 }),
          ),
        );
        await until(() => state.listenAttempts.length > 0);
      } else {
        await plugin.subscribe(topic, () => undefined);
        if (cell.chore === 'reconnect-connect') {
          const gate = deferred();
          state.connectGate = gate;
          release = gate.resolve;
        }
        state.clients[0]?.emit('end');
        // reconnect-connect must reach the candidate's parked connect() (past the 500ms backoff);
        // reconnect-backoff must land while the loop is still sleeping.
        await sleep(cell.chore === 'reconnect-connect' ? 700 : 100);
      }

      const older = [...state.clients];
      await plugin.disconnect();
      const got: Message[] = [];
      if (cell.next === 'disconnect+connect') {
        // The successor builds its OWN listener and registration BEFORE the parked chore wakes, so
        // a chore that publishes anyway overwrites something live rather than filling a vacuum.
        await plugin.connect({ url: REAL_URL });
        await plugin.subscribe(topic, (m) => got.push(m));
      }
      const deletesAtBoundary = state.deletes.length;
      const releasedAt = Date.now();
      release?.();
      // Past one whole reconnect backoff, so a loop that did not abort has woken and acted.
      await sleep(900);
      await Promise.all(pending);

      // The parked seam call has to come back when the teardown releases it, not when its own
      // block budget finally runs out: a guard that only stops the chore from PUBLISHING still
      // leaves the caller parked for up to catchup.block_max_ms past the teardown.
      for (const at of settledAt) {
        expect(at - releasedAt, 'a parked seam call outlived the teardown that released it').toBeLessThan(
          1000,
        );
      }
      // A chore woken after the boundary must not issue one more statement — least of all against
      // the successor lifecycle's pool, which is a different table with a different retention.
      expect(
        state.deletes.length - deletesAtBoundary,
        'the prune loop kept deleting past the teardown',
      ).toBe(0);

      if (cell.next === 'disconnect') {
        expect(priv.listener, 'listener resurrected after disconnect').toBeUndefined();
        expect(priv.listenerPromise).toBeUndefined();
        expect(registrySizes(priv), 'registry survived teardown').toEqual({
          subs: 0,
          subscribing: 0,
          listens: 0,
          waiters: 0,
          pendingAborts: 0,
        });
      } else {
        expect(priv.listener, 'the new lifecycle has no listener connection').toBeDefined();
        expect(older, 'a connection from the previous lifecycle is still the live listener').not.toContain(
          priv.listener,
        );
        expect(registrySizes(priv), 'the new lifecycle inherited registry state').toEqual({
          subs: 1,
          subscribing: 0,
          listens: 1,
          waiters: 0,
          pendingAborts: 0,
        });

        const channel = [...priv.listens.keys()][0] as string;
        expect(
          (priv.listener as unknown as MockClientShape & { listened: string[] }).listened,
          'the new lifecycle never LISTENed the topic it subscribed to',
        ).toContain(channel);

        state.rows.set('t', [
          {
            seq: '1',
            topic: 't',
            sender: asHandle('u'),
            content: 'after-reuse',
            ts: new Date().toISOString(),
            in_reply_to: null,
          },
        ]);
        (priv.listener as unknown as MockClientShape).emit('notification', { channel });
        await sleep(60);
        expect(got.map((m) => m.content), 'push is dead on the reused topic').toEqual([
          'after-reuse',
        ]);
        await plugin.disconnect();
      }

      // Whatever happened, no socket is left both unreachable and open.
      for (const c of state.clients) {
        expect(
          c === priv.listener || c.ended,
          'a Client is neither the current listener nor ended',
        ).toBe(true);
      }
    },
    15000,
  );
});

describe('Postgres subscribe registration', () => {
  // `subscribing` is keyed by channel, and the channel for a topic is the same in every lifecycle.
  // So the cleanup in subscribe()'s `finally` is aimed at a key a SUCCESSOR may already own: evicting
  // it makes a concurrent subscribe miss the in-flight registration, build a second one, and inflate
  // the channel's LISTEN refcount while dropping the first registration's handlers.
  it('a subscribe rejected by teardown does not evict the successor lifecycle in-flight entry', async () => {
    const plugin = new PostgresPlugin();
    const priv = plugin as unknown as {
      subs: Map<string, { handlers: unknown[] }>;
      subscribing: Map<string, unknown>;
      listens: Map<string, { refs: number }>;
    };
    const topic = asTopic('t');
    await plugin.connect({ url: REAL_URL });

    const first = deferred();
    state.listenGate = first;
    const doomed = plugin.subscribe(topic, () => undefined).catch(() => 'rejected');
    await until(() => state.listenAttempts.length === 1);

    await plugin.disconnect();
    await plugin.connect({ url: REAL_URL });

    const successor = deferred();
    state.listenGate = successor;
    const boxA: Message[] = [];
    const joinA = plugin.subscribe(topic, (m) => boxA.push(m));
    await until(() => state.listenAttempts.length === 2);

    first.resolve();
    expect(await doomed).toBe('rejected');
    expect(priv.subscribing.size, 'the successor in-flight registration was evicted').toBe(1);

    const boxB: Message[] = [];
    const joinB = plugin.subscribe(topic, (m) => boxB.push(m));
    successor.resolve();
    await Promise.all([joinA, joinB]);

    expect(priv.subs.size).toBe(1);
    expect([...priv.subs.values()][0]?.handlers.length, 'a handler was dropped').toBe(2);
    expect([...priv.listens.values()].map((l) => l.refs), 'LISTEN refcount inflated').toEqual([1]);
    expect(state.listenAttempts.length, 'a duplicate LISTEN was issued').toBe(2);

    await plugin.disconnect();
  }, 10000);


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

// The reconnect loop exists to make a notification blackout cost latency and not a message. The
// class it keeps getting wrong is asymmetric recovery: a NOTIFY rung while the connection was down
// reached NOBODY and nothing rings it again, so the reconnect owes a re-drive to EVERY participant
// registry it re-LISTENed a channel for — the subscriptions AND the blocking `fetchRecent` waiters
// parked on the same doorbell. Re-driving one and not the other is invisible to a test that only
// asks whether the channel came back: subscriptions recover in one backoff while a waiter sleeps
// out its whole block budget (core passes `catchup.block_max_ms`, default 60s) and answers empty
// with the row durably visible.
//
// So both participant kinds are seeded with rows landing DURING the blackout, and both are graded
// on delivery, against a bound far below the block budget — "it came back when its own timer
// expired" is the defect, not a pass.

const DRAIN_BATCH = 512;
/** The waiter's block budget; a recovery that costs this much is the defect, not the fix. */
const BLOCK_MS = 4000;
/** The plugin's own backoff between listener reconnect attempts. */
const RECONNECT_DELAY_MS = 500;

interface ReconnectCell {
  topics: number;
  waiters: number;
  rows: number;
  /** Which reconnect attempt is allowed to land — a blackout the first try does not end. */
  attempt: number;
}

const RECONNECT_CELLS: ReconnectCell[] = [0, 1, 2].flatMap((topics) =>
  [0, 1].flatMap((waiters) =>
    [0, 1, DRAIN_BATCH + 1].map((rows) => ({ topics, waiters, rows, attempt: 1 })),
  ),
);

/**
 * The same class one layer out: the re-drive has to be tied to the attempt that ACTUALLY landed,
 * not to entering the loop. One row per participant kind, because a fan-out written into the wrong
 * place strands whichever registry it was not written beside.
 */
const RETRY_CELLS: ReconnectCell[] = (['subscription', 'waiter'] as const).map((who) => ({
  topics: who === 'subscription' ? 1 : 0,
  waiters: who === 'waiter' ? 1 : 0,
  rows: 1,
  attempt: 3,
}));

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

const reconnectLabel = (c: ReconnectCell): string =>
  `${c.topics} subscription(s), ${c.waiters} blocking waiter(s), ${c.rows} row(s), ` +
  `reconnect lands on attempt ${c.attempt}`;

interface ParkedFetch {
  topic: string;
  settled?: { afterMs: number; contents: string[] };
  done: Promise<void>;
}

async function reconnectCase(cell: ReconnectCell): Promise<void> {
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

  const waitTopics = Array.from({ length: cell.waiters }, (_, i) => `waiting${i}`);
  const waits: ParkedFetch[] = waitTopics.map((t) => {
    const startedAt = Date.now();
    const parked: ParkedFetch = {
      topic: t,
      done: plugin
        .fetchRecent({ topic: asTopic(t), since: asCursor('0'), blockMs: BLOCK_MS })
        .then((page) => {
          parked.settled = {
            afterMs: Date.now() - startedAt,
            contents: page.messages.map((m) => m.content),
          };
        }),
    };
    return parked;
  });
  // Let every waiter park before anything becomes visible: a row seeded earlier is caught by the
  // plugin's own post-registration re-check, and the cell would never exercise the blackout at all.
  if (waits.length > 0) await sleep(20);

  const channelsNeeded = [...(plugin as unknown as { listens: Map<string, unknown> }).listens.keys()];

  const listener = state.clients[0];
  if (listener === undefined) {
    // Nothing subscribed and nothing waiting: the listener connection is lazy, so there is no
    // blackout to recover from.
    expect(channelsNeeded).toEqual([]);
    expect(cell.topics + cell.waiters, 'a participant registered no LISTEN at all').toBe(0);
    await plugin.disconnect();
    return;
  }
  state.connectFailures = cell.attempt - 1;
  listener.emit('end');
  // The rows land DURING the blackout: their NOTIFY reaches nobody, and nothing rings it again.
  for (const t of [...subTopics, ...waitTopics]) state.rows.set(t, blackoutRows(t, cell.rows));

  // Past the backoff of every attempt this cell burns, the replacement client must be live.
  await sleep(RECONNECT_DELAY_MS * cell.attempt + 400);
  const replacement = state.clients.at(-1);
  expect(replacement).toBeDefined();
  expect(replacement).not.toBe(listener);
  for (const channel of channelsNeeded) {
    expect(replacement?.listened, `re-LISTEN missing for ${channel}`).toContain(channel);
  }

  // No NOTIFY is emitted: the reconnect's own re-drive is what must serve both registries.
  await sleep(100);
  const want = Array.from({ length: cell.rows }, (_, i) => `m${i}`);
  for (const t of subTopics) {
    const got = seen.get(t) ?? [];
    expect(got.map((m) => m.content), `the subscription on ${t} was not re-driven`).toEqual(want);
    expect(new Set(got.map((m) => m.backendMsgId)).size, 'duplicate delivery').toBe(got.length);
  }
  for (const parked of waits) {
    // With nothing to deliver a wake is allowed but not owed, so only the seeded cells grade one.
    if (cell.rows === 0) continue;
    const settled = parked.settled;
    expect(
      settled,
      `the blocking fetch on ${parked.topic} was still parked a whole reconnect after the row landed`,
    ).toBeDefined();
    expect(
      (settled as { contents: string[] }).contents,
      `the blocking fetch on ${parked.topic} came back empty`,
    ).toEqual(want.slice(0, (settled as { contents: string[] }).contents.length));
    expect(
      (settled as { contents: string[] }).contents.length,
      `the blocking fetch on ${parked.topic} came back empty`,
    ).toBeGreaterThan(0);
    expect(
      (settled as { afterMs: number }).afterMs,
      `the blocking fetch on ${parked.topic} slept out its block budget instead of being re-driven`,
    ).toBeLessThan(BLOCK_MS / 2);
  }

  await plugin.disconnect();
  await Promise.all(waits.map((w) => w.done));
}

describe('Postgres listener reconnect re-drives every participant the blackout starved', () => {
  it.each(RECONNECT_CELLS.map((c) => [reconnectLabel(c), c] as const))(
    '%s',
    async (_label, cell) => {
      await reconnectCase(cell);
    },
    15000,
  );

  it.each(RETRY_CELLS.map((c) => [reconnectLabel(c), c] as const))(
    '%s',
    async (_label, cell) => {
      await reconnectCase(cell);
    },
    15000,
  );
});
