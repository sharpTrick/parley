import { existsSync, mkdtempSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDriver, type SqlDriver } from '../src/driver.js';
import { SqlitePlugin } from '../src/index.js';
import { SCHEMA } from '../src/schema.js';

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

describe('subscriptionHealth never reports a loop that cannot deliver', () => {
  it('every live loop reads as stopped after disconnect, and stays that way', async () => {
    const p = tracked();
    await p.connect(cfg(dbFile()));
    const got: string[] = [];
    await p.subscribe(T, (m) => got.push(m.content));
    await p.subscribe(asTopic('other'), () => {});
    await p.post(T, me, 'while-live');
    await vi.waitFor(() => expect(got).toEqual(['while-live']), { timeout: 2000, interval: 5 });
    expect(p.subscriptionHealth().map((h) => h.state)).toEqual(['live', 'live']);

    await p.disconnect();

    const after = p.subscriptionHealth();
    expect(after.map((h) => h.topic)).toEqual(['ctx', 'other']);
    expect(after.map((h) => h.state)).toEqual(['stopped', 'stopped']);
    expect(after.every((h) => h.lastError !== undefined)).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(p.subscriptionHealth().map((h) => h.state)).toEqual(['stopped', 'stopped']);
  });

  it('a reconnect reports nothing from the previous generation until it subscribes again', async () => {
    const path = dbFile();
    const p = tracked();
    await p.connect(cfg(path));
    await p.subscribe(T, () => {});
    await p.disconnect();

    await p.connect(cfg(path));
    expect(p.subscriptionHealth()).toEqual([]);

    const got: string[] = [];
    await p.subscribe(T, (m) => got.push(m.content));
    await p.post(T, me, 'second-generation');
    await vi.waitFor(() => expect(got).toEqual(['second-generation']), {
      timeout: 2000,
      interval: 5,
    });
    expect(p.subscriptionHealth().map((h) => h.state)).toEqual(['live']);
  });
});
