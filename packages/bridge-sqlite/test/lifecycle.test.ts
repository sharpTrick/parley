import { existsSync, mkdtempSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDriver, type SqlDriver } from '../src/driver.js';
import { POLL_BATCH, SqlitePlugin } from '../src/index.js';
import { SCHEMA } from '../src/schema.js';
import { type ExpectedHealth, expectHealth } from './health.js';

/**
 * `connect`/`disconnect` are the entire lifecycle the seam declares, and an embedder — or a future
 * core reconnect path — will call them in orders the happy path never does. Every such order has to
 * either fail loudly or fully re-establish: a half-applied connect leaves poll loops delivering into
 * a store nobody reads, and `subscriptionHealth()` is what a supervisor decides to restart on, so a
 * loop that cannot deliver must never be reported as one that can.
 */

const T = asTopic('ctx');
const me = asHandle('alice');
const dbFile = () => join(mkdtempSync(join(tmpdir(), 'parley-life-')), 'p.db');

/**
 * Counts every call `connect()` makes against an opened driver, and can make the nth one throw.
 * `connect()` opens the store and then does several things that can fail — a schema that drifted, a
 * file that is not a database, a `parley_meta` that cannot hold a store id — so the failure has to
 * be injectable per step rather than per known symptom.
 */
const fault = vi.hoisted(() => ({ throwOnCall: 0, calls: 0, opens: 0, closes: 0 }));

vi.mock('../src/driver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/driver.js')>();
  return {
    ...real,
    openDriver: (path: string, opts?: { busyTimeoutMs?: number }): SqlDriver => {
      const d = real.openDriver(path, opts);
      fault.opens++;
      const guard = <R>(fn: () => R): R => {
        fault.calls++;
        if (fault.calls === fault.throwOnCall) {
          throw Object.assign(new Error(`injected failure at driver call ${fault.calls}`), {
            code: 'SQLITE_ERROR',
          });
        }
        return fn();
      };
      return {
        kind: d.kind,
        exec: (sql) => guard(() => d.exec(sql)),
        prepare: (sql) =>
          guard(() => {
            const st = d.prepare(sql);
            return {
              run: (...p) => guard(() => st.run(...p)),
              get: (...p) => guard(() => st.get(...p)),
              all: (...p) => guard(() => st.all(...p)),
            };
          }),
        close: () => {
          fault.closes++;
          d.close();
        },
      };
    },
  };
});

let open: SqlitePlugin[] = [];
function tracked(): SqlitePlugin {
  const p = new SqlitePlugin();
  open.push(p);
  return p;
}
afterEach(async () => {
  fault.throwOnCall = 0;
  await Promise.all(open.map((p) => p.disconnect()));
  open = [];
});

async function attempt(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

interface Order {
  name: string;
  /** Drive the sequence; return the message the last (out-of-order) call threw, if any. */
  run: (p: SqlitePlugin, a: string, b: string, got: string[]) => Promise<string | undefined>;
  /** What the offending call must throw, or null if it must be accepted. */
  mustThrow: RegExp | null;
  /** Whether the plugin must still accept a `post` afterwards. */
  serving: boolean;
  /** Whether a loop subscribed before the offending call must still deliver afterwards. */
  loopDelivers: boolean;
}

const cfg = (path: string) => ({ db_path: path, poll_interval_ms: 10 });

const ORDERS: Order[] = [
  {
    name: 'connect then connect to another store',
    mustThrow: /already connected/,
    serving: true,
    loopDelivers: false,
    run: async (p, a, b) => {
      await p.connect(cfg(a));
      return attempt(() => p.connect(cfg(b)));
    },
  },
  {
    name: 'connect then connect to the same store',
    mustThrow: /already connected/,
    serving: true,
    loopDelivers: false,
    run: async (p, a) => {
      await p.connect(cfg(a));
      return attempt(() => p.connect(cfg(a)));
    },
  },
  {
    name: 'connect, subscribe, then connect to another store',
    mustThrow: /already connected/,
    serving: true,
    loopDelivers: true,
    run: async (p, a, b, got) => {
      await p.connect(cfg(a));
      for (let i = 0; i < 20; i++) await p.post(T, me, `history-${i}`);
      await p.subscribe(T, (m) => got.push(m.content));
      return attempt(() => p.connect(cfg(b)));
    },
  },
  {
    name: 'connect, subscribe, disconnect, connect again',
    mustThrow: null,
    serving: true,
    loopDelivers: false,
    run: async (p, a, b, got) => {
      await p.connect(cfg(a));
      await p.subscribe(T, (m) => got.push(m.content));
      await p.disconnect();
      return attempt(() => p.connect(cfg(b)));
    },
  },
  {
    name: 'connect, disconnect, disconnect',
    mustThrow: null,
    serving: false,
    loopDelivers: false,
    run: async (p, a) => {
      await p.connect(cfg(a));
      await p.disconnect();
      return attempt(() => p.disconnect());
    },
  },
  {
    name: 'subscribe after disconnect',
    mustThrow: /not connected/,
    serving: false,
    loopDelivers: false,
    run: async (p, a, _b, got) => {
      await p.connect(cfg(a));
      await p.disconnect();
      return attempt(() => p.subscribe(T, (m) => got.push(m.content)));
    },
  },
  {
    name: 'post after disconnect',
    mustThrow: /not connected/,
    serving: false,
    loopDelivers: false,
    run: async (p, a) => {
      await p.connect(cfg(a));
      await p.disconnect();
      return attempt(() => p.post(T, me, 'orphan'));
    },
  },
  {
    name: 'fetchRecent after disconnect',
    mustThrow: /not connected/,
    serving: false,
    loopDelivers: false,
    run: async (p, a) => {
      await p.connect(cfg(a));
      await p.disconnect();
      return attempt(() => p.fetchRecent({ topic: T }));
    },
  },
];

describe('a lifecycle call in an unexpected order fails loudly or fully re-establishes', () => {
  for (const order of ORDERS) {
    it(order.name, async () => {
      const p = tracked();
      const got: string[] = [];
      const threw = await order.run(p, dbFile(), dbFile(), got);

      if (order.mustThrow === null) {
        expect(threw).toBeUndefined();
      } else {
        expect(threw).toMatch(order.mustThrow);
        expect(threw).toMatch(/parley-sqlite|SqlitePlugin/);
      }

      const probeFailed = await attempt(() => p.post(T, me, 'probe'));
      expect(probeFailed === undefined).toBe(order.serving);

      if (order.loopDelivers) {
        await vi.waitFor(() => expect(got).toContain('probe'), { timeout: 2000, interval: 5 });
      } else {
        await new Promise((r) => setTimeout(r, 60));
        expect(got).not.toContain('probe');
      }

      // The health report is only worth reading if it cannot claim a loop that just failed to
      // deliver: nothing may say 'live' unless a post really did reach a handler.
      const live = p.subscriptionHealth().filter((h) => h.state === 'live');
      expect(live.length > 0).toBe(order.loopDelivers);
    });
  }
});

/**
 * A `connect()` that fails AFTER the file is open is the case an operator hits with a typo'd path or
 * a store an older build wrote, and the case a supervisor retries. Two things must hold for every
 * such failure: the open handle is closed (otherwise a retry loop leaks one file descriptor per
 * attempt until the process runs out), and no field is left set (otherwise the instance answers
 * "already connected" to the next connect and "not connected" to every operation — permanently
 * wedged with no call the caller has a reason to make).
 */
describe('a connect() that fails after opening the store leaves nothing behind', () => {
  interface PostOpenFailure {
    name: string;
    plant: (path: string) => void;
    cause: RegExp;
  }

  const POST_OPEN_FAILURES: PostOpenFailure[] = [
    {
      name: 'a db_path that is not a database',
      plant: (path) => writeFileSync(path, 'my notes, not a message store — an operator typo\n'),
      cause: /file is not a database/i,
    },
    {
      name: 'a messages table drifted from an older schema',
      plant: (path) => {
        const d = openDriver(path);
        d.exec(
          'CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, ' +
            'sender TEXT NOT NULL, content TEXT NOT NULL, ts TEXT NOT NULL)',
        );
        d.close();
      },
      cause: /in_reply_to/,
    },
    {
      name: 'a parley_meta that cannot hold a store id',
      plant: (path) => {
        const d = openDriver(path);
        d.exec(SCHEMA);
        d.exec('DROP TABLE parley_meta');
        d.exec(
          'CREATE TABLE parley_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, ' +
            'shard TEXT NOT NULL)',
        );
        d.close();
      },
      cause: /store id/i,
    },
  ];

  async function assertFailedConnectIsInert(
    p: SqlitePlugin,
    cause: RegExp,
    connect: () => Promise<void>,
  ): Promise<void> {
    const opened = fault.opens;
    const closed = fault.closes;
    expect(await attempt(connect)).toMatch(cause);
    // Every driver handed to connect() is closed again. A path that fails inside openDriver hands
    // out none, and the descriptor count below is what grades that one.
    expect(fault.closes - closed).toBe(fault.opens - opened);

    expect(await attempt(() => p.post(T, me, 'orphan'))).toMatch(/not connected/);
    expect(await attempt(() => p.fetchRecent({ topic: T }))).toMatch(/not connected/);
    expect(p.subscriptionHealth()).toEqual([]);

    fault.throwOnCall = 0;
    expect(await attempt(() => p.connect(cfg(dbFile())))).toBeUndefined();
    expect(await attempt(() => p.post(T, me, 'after-recovery'))).toBeUndefined();
  }

  for (const f of POST_OPEN_FAILURES) {
    it(`${f.name}: rejects, closes the handle, and a retry still connects`, async () => {
      const p = tracked();
      const path = join(mkdtempSync(join(tmpdir(), 'parley-life-')), 'p.db');
      f.plant(path);
      await assertFailedConnectIsInert(p, f.cause, () => p.connect(cfg(path)));
    });
  }

  /**
   * One row per call `connect()` makes against the driver, so a step added to `connect()` later is
   * covered without a new row — and the count is pinned, so adding one past the end of this table
   * fails here rather than shipping ungraded.
   */
  const FAULT_POSITIONS = Array.from({ length: 11 }, (_unused, i) => i + 1);

  it(`connect() makes exactly ${FAULT_POSITIONS.length} driver calls, one per row below`, async () => {
    const p = tracked();
    fault.throwOnCall = 0;
    fault.calls = 0;
    await p.connect(cfg(dbFile()));
    expect(fault.calls).toBe(FAULT_POSITIONS.length);
  });

  for (const nth of FAULT_POSITIONS) {
    it(`a failure at driver call ${nth} rejects, closes the handle, and a retry still connects`, async () => {
      const p = tracked();
      fault.calls = 0;
      fault.throwOnCall = nth;
      await assertFailedConnectIsInert(p, /injected failure at driver call/, () =>
        p.connect(cfg(dbFile())),
      );
    });
  }

  it.skipIf(!existsSync('/proc/self/fd'))(
    '50 failed connects against the same bad path leak no file descriptors',
    async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'parley-life-')), 'notes.txt');
      writeFileSync(path, 'not a database\n');
      const openHandles = (): number =>
        readdirSync('/proc/self/fd').filter((fd) => {
          try {
            return readlinkSync(join('/proc/self/fd', fd)) === path;
          } catch {
            return false;
          }
        }).length;

      const before = openHandles();
      for (let i = 0; i < 50; i++) {
        expect(await attempt(() => new SqlitePlugin().connect(cfg(path)))).toMatch(
          /file is not a database/i,
        );
      }
      expect(openHandles() - before).toBe(0);
    },
  );
});

/**
 * A handler runs synchronously inside the poll tick, so a consumer that re-enters the lifecycle on
 * an inbound control message does so while a batch of rows is already in memory. The conformance
 * clause `disconnect-stops-live-delivery` is what core's `<channel>` emission rests on, and it is
 * graded there only from OUTSIDE the handler, where no row can be pending when the flags flip.
 *
 * A re-entrant lifecycle call is a FAMILY, not one action, and what decides whether the loop may go
 * on is which connect() armed it — never whether the plugin currently looks connected, which a
 * `disconnect()`/`connect()` pair restores mid-tick and mid-batch. So the row here is the re-entrant
 * action, and each grades the same pair: the loop delivers exactly what its OWN store held for it,
 * and not one row of a store it was never armed against. Content names the store it was written to,
 * which is what makes a resumed cross-store loop visible — a delivery count cannot see one, and
 * neither can the cursor, which carries the id captured at subscribe() whatever store the row
 * actually came from.
 *
 * Fake timers make the batch explicit rather than raced: every row posted between two ticks arrives
 * in one, so the re-entry row is a POSITION in a known batch.
 */
describe('a lifecycle call re-entered from inside a handler decides that loop\u2019s fate', () => {
  interface Reentry {
    name: string;
    /** Run from inside the handler, on the chosen row. */
    act: (p: SqlitePlugin, a: string, b: string, refusals: string[]) => void;
    /** What the re-entrant call must be refused with, or null if it must be accepted. */
    refused: RegExp | null;
    /** Whether the loop is still this plugin's afterwards — a refused call changes nothing. */
    survives: boolean;
  }

  const REENTRIES: Reentry[] = [
    {
      name: 'disconnects',
      refused: null,
      survives: false,
      act: (p) => {
        void p.disconnect();
      },
    },
    {
      name: 'disconnects twice',
      refused: null,
      survives: false,
      act: (p) => {
        void p.disconnect();
        void p.disconnect();
      },
    },
    {
      name: 'disconnects then reconnects to the same store',
      refused: null,
      survives: false,
      act: (p, a, _b, refusals) => {
        void p.disconnect();
        void p.connect(cfg(a)).catch((e: unknown) => refusals.push(String(e)));
      },
    },
    {
      name: 'disconnects then connects to another store',
      refused: null,
      survives: false,
      act: (p, _a, b, refusals) => {
        void p.disconnect();
        void p.connect(cfg(b)).catch((e: unknown) => refusals.push(String(e)));
      },
    },
    {
      name: 'connects to another store without disconnecting',
      refused: /already connected/,
      survives: true,
      act: (p, _a, b, refusals) => {
        void p.connect(cfg(b)).catch((e: unknown) => refusals.push(String(e)));
      },
    },
  ];

  const reentryPositions = (pending: number): number[] =>
    [...new Set([1, Math.ceil(pending / 2), pending])];

  const storeIdIn = (cursor: string): string => cursor.split('.')[0] ?? '';

  for (const pending of [1, 2, POLL_BATCH]) {
    for (const at of reentryPositions(pending)) {
      for (const r of REENTRIES) {
        it(`${pending} row(s) in the batch, handler ${r.name} on row ${at}`, async () => {
          const a = dbFile();
          const b = dbFile();
          const p = tracked();
          await p.connect(cfg(a));
          const got: Array<{ content: string; cursor: string }> = [];
          const refusals: string[] = [];
          const armed = (n: number): string[] => Array.from({ length: n }, (_u, i) => `a${i}`);

          vi.useFakeTimers();
          try {
            await p.subscribe(T, (m) => {
              got.push({ content: m.content, cursor: m.cursor });
              if (got.length !== at) return;
              r.act(p, a, b, refusals);
            });
            for (let i = 0; i < pending; i++) await p.post(T, me, `a${i}`);
            await vi.advanceTimersByTimeAsync(1000);

            if (r.refused === null) {
              expect(refusals).toEqual([]);
            } else {
              expect(
                refusals.join('|'),
                'the re-entrant call is accepted now, so this row no longer provokes the case it names',
              ).toMatch(r.refused);
            }
            expect(got.map((g) => g.content)).toEqual(armed(r.survives ? pending : at));
            // A loop that stops delivering but keeps re-arming is invisible in content and in
            // health — `connect()` empties the health list and `disconnect()` empties the cancellers
            // — so the armed timer is the only thing left that can see it. It is also the whole
            // harm: nothing can stop it, and it holds the event loop for a poll interval that may
            // be configured in days.
            expect(
              vi.getTimerCount(),
              'a loop that is no longer this plugin\u2019s left a timer armed, and disconnect() has ' +
                'already emptied the canceller list that could have stopped it',
            ).toBe(r.survives ? 1 : 0);

            // The loop must be gone — or still be this plugin's — rather than merely out of rows,
            // and it must not have been adopted by whichever store the re-entrant call left
            // connected. Both stores keep being written to past the read position the loop reached
            // while the timers run on, so a loop resumed against either one shows as a delivery.
            const peerA = tracked();
            await peerA.connect(cfg(a));
            const peerB = tracked();
            await peerB.connect(cfg(b));
            for (let i = 0; i < pending + 8; i++) {
              await peerA.post(T, me, `a-later-${i}`);
              await peerB.post(T, me, `b${i}`);
            }
            await vi.advanceTimersByTimeAsync(1000);

            const contents = got.map((g) => g.content);
            expect(
              contents.filter((c) => c.startsWith('b')),
              'the loop delivered rows out of a store it was never armed against',
            ).toEqual([]);

            const armedStore = storeIdIn(
              (await peerA.fetchRecent({ topic: T })).messages[0]?.cursor ?? '',
            );
            expect(armedStore).not.toBe('');
            expect([...new Set(got.map((g) => storeIdIn(g.cursor)))]).toEqual([armedStore]);

            if (r.survives) {
              expect(contents.length).toBeGreaterThan(pending);
            } else {
              expect(contents).toEqual(armed(at));
            }
            expect(p.subscriptionHealth().some((h) => h.state === 'live')).toBe(r.survives);
          } finally {
            vi.useRealTimers();
          }
        });
      }
    }
  }
});

describe('subscriptionHealth never reports a loop that cannot deliver', () => {
  it('every live loop reads as stopped after disconnect, and stays that way', async () => {
    const p = tracked();
    await p.connect(cfg(dbFile()));
    const got: string[] = [];
    await p.subscribe(T, (m) => got.push(m.content));
    await p.subscribe(asTopic('other'), () => {});
    await p.post(T, me, 'while-live');
    await vi.waitFor(() => expect(got).toEqual(['while-live']), { timeout: 2000, interval: 5 });
    const other = asTopic('other');
    expectHealth(p.subscriptionHealth(), [
      { topic: T, state: 'live', consecutiveFailures: 0 },
      { topic: other, state: 'live', consecutiveFailures: 0 },
    ]);

    await p.disconnect();

    const torndown: ExpectedHealth[] = [
      { topic: T, state: 'stopped', consecutiveFailures: 0, lastError: /^disconnected$/ },
      { topic: other, state: 'stopped', consecutiveFailures: 0, lastError: /^disconnected$/ },
    ];
    expectHealth(p.subscriptionHealth(), torndown);
    await new Promise((r) => setTimeout(r, 60));
    expectHealth(p.subscriptionHealth(), torndown);
  });

  /**
   * `subscribe()` starts an independent loop per call, including on a topic already subscribed. A
   * report keyed by topic would collapse those into one record, so a supervisor could read a
   * surviving loop's `live` for a sibling that has permanently stopped.
   */
  for (const loops of [1, 2, 3]) {
    it(`${loops} loop(s) on one topic report ${loops} record(s), and every one of them delivers`, async () => {
      const p = tracked();
      await p.connect(cfg(dbFile()));
      const sinks = Array.from({ length: loops }, () => [] as string[]);
      for (const sink of sinks) await p.subscribe(T, (m) => sink.push(m.content));

      const live = (state: 'live' | 'stopped'): ExpectedHealth[] =>
        Array.from({ length: loops }, () => ({
          topic: T,
          state,
          consecutiveFailures: 0,
          ...(state === 'stopped' ? { lastError: /^disconnected$/ } : {}),
        }));
      expectHealth(p.subscriptionHealth(T), live('live'));

      await p.post(T, me, 'fan-out');
      await vi.waitFor(
        () => expect(sinks).toEqual(Array.from({ length: loops }, () => ['fan-out'])),
        { timeout: 2000, interval: 5 },
      );

      await p.disconnect();
      expectHealth(p.subscriptionHealth(T), live('stopped'));
    });
  }

  it('a reconnect reports nothing from the previous generation until it subscribes again', async () => {
    const path = dbFile();
    const p = tracked();
    await p.connect(cfg(path));
    await p.subscribe(T, () => {});
    await p.disconnect();

    await p.connect(cfg(path));
    expectHealth(p.subscriptionHealth(), []);

    const got: string[] = [];
    await p.subscribe(T, (m) => got.push(m.content));
    await p.post(T, me, 'second-generation');
    await vi.waitFor(() => expect(got).toEqual(['second-generation']), {
      timeout: 2000,
      interval: 5,
    });
    expectHealth(p.subscriptionHealth(), [{ topic: T, state: 'live', consecutiveFailures: 0 }]);
  });
});
