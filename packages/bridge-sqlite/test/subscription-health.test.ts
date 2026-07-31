import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffMs, classifyDbError, ESCALATE_AFTER, SqlitePlugin } from '../src/index.js';
import { type ExpectedHealth, expectHealth } from './health.js';

/**
 * `subscriptionHealth()` is the programmatic surface the README points a supervisor at, and a
 * supervisor reads more than `state`: a restart decision keys off `consecutiveFailures` and
 * `lastError` too. Every transition therefore grades the WHOLE record — a recovery path that
 * clears the discriminant but leaves the diagnosis behind reports a healthy loop that any
 * `lastError !== undefined` check will keep restarting.
 *
 * Driven on fake timers so each row lands on an exact failure count rather than a raced one.
 */

const T = asTopic('ctx');
const me = asHandle('alice');
const INTERVAL_MS = 1000;
const dbFile = () => join(mkdtempSync(join(tmpdir(), 'parley-health-')), 'p.db');

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function err(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

const IOERR = () => err('disk I/O error', 'SQLITE_IOERR');
const CORRUPT = () => err('database disk image is malformed', 'SQLITE_CORRUPT');
const BUSY = () => err('database is locked', 'SQLITE_BUSY');

interface Stmt {
  all(...a: unknown[]): unknown[];
  get(...a: unknown[]): unknown;
  run(...a: unknown[]): unknown;
}

interface Loop {
  plugin: SqlitePlugin;
  delivered: string[];
  /** Make every subsequent poll tick throw `e`, until {@link Loop.mend}. */
  breakWith(e: Error): void;
  /** Make the nth faulted poll tick throw `at(nth)`, counting from 0, until {@link Loop.mend}. */
  breakEach(at: (nth: number) => Error): void;
  mend(): void;
  post(content: string): Promise<void>;
  advance(ms: number): Promise<void>;
  ticks(n: number): Promise<void>;
  /** Run exactly `n` more ticks, one timer at a time, each of which must hit the fault. */
  faultedTicks(n: number): Promise<void>;
}

let open: SqlitePlugin[] = [];
let stderrSpy: { mock: { calls: unknown[][] } };
const stderrLines = (): string[] => stderrSpy.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.useFakeTimers();
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(async () => {
  for (const p of open) await p.disconnect();
  open = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function startLoop(): Promise<Loop> {
  const plugin = new SqlitePlugin();
  open.push(plugin);
  await plugin.connect({ db_path: dbFile(), poll_interval_ms: INTERVAL_MS });

  const holder = plugin as unknown as { selectAfterStmt: Stmt };
  const real = holder.selectAfterStmt;
  let fault: ((nth: number) => Error) | undefined;
  let faulted = 0;
  holder.selectAfterStmt = {
    // Faulted for THIS topic only, so a second subscription on the same statement stays healthy.
    all: (...a: unknown[]) => {
      if (fault !== undefined && a[0] === T) throw fault(faulted++);
      return real.all(...a);
    },
    get: (...a: unknown[]) => real.get(...a),
    run: (...a: unknown[]) => real.run(...a),
  };

  const delivered: string[] = [];
  await plugin.subscribe(T, (m) => delivered.push(m.content));

  const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  return {
    plugin,
    delivered,
    breakWith: (e) => {
      fault = () => e;
    },
    breakEach: (at) => {
      fault = at;
    },
    mend: () => {
      fault = undefined;
    },
    post: async (content) => {
      await plugin.post(T, me, content);
    },
    advance,
    ticks: (n) => advance(n * INTERVAL_MS),
    faultedTicks: async (n) => {
      for (let i = 0; i < n; i++) {
        const before = faulted;
        await vi.advanceTimersToNextTimerAsync();
        expect(faulted, `tick ${i + 1} of ${n} did not reach the store`).toBe(before + 1);
      }
    },
  };
}

const TRANSITIONS: Array<{
  name: string;
  drive: (loop: Loop) => Promise<void>;
  expected: ExpectedHealth[];
}> = [
  {
    name: 'a loop that has just been armed',
    drive: async () => {},
    expected: [{ topic: T, state: 'live', consecutiveFailures: 0 }],
  },
  {
    name: 'a loop that has polled quietly',
    drive: (l) => l.ticks(5),
    expected: [{ topic: T, state: 'live', consecutiveFailures: 0 }],
  },
  {
    name: 'a loop that has delivered',
    drive: async (l) => {
      await l.post('live-message');
      await l.ticks(1);
      expect(l.delivered).toEqual(['live-message']);
    },
    expected: [{ topic: T, state: 'live', consecutiveFailures: 0 }],
  },
  {
    name: 'a non-lock failure one tick below the escalation threshold',
    drive: async (l) => {
      l.breakWith(IOERR());
      await l.ticks(ESCALATE_AFTER - 1);
    },
    expected: [
      { topic: T, state: 'live', consecutiveFailures: ESCALATE_AFTER - 1, lastError: /disk I\/O/ },
    ],
  },
  {
    name: 'a healable failure at the escalation threshold',
    drive: async (l) => {
      l.breakWith(IOERR());
      await l.ticks(ESCALATE_AFTER);
    },
    expected: [
      { topic: T, state: 'degraded', consecutiveFailures: ESCALATE_AFTER, lastError: /disk I\/O/ },
    ],
  },
  {
    name: 'a fatal failure at the escalation threshold, and long after it',
    drive: async (l) => {
      l.breakWith(CORRUPT());
      await l.ticks(ESCALATE_AFTER);
      l.mend();
      await l.advance(10 * 60_000);
    },
    expected: [
      { topic: T, state: 'stopped', consecutiveFailures: ESCALATE_AFTER, lastError: /malformed/ },
    ],
  },
  {
    name: 'a lock-classed tick, which counts but does not clear a burst of non-lock failures',
    drive: async (l) => {
      l.breakWith(IOERR());
      await l.ticks(3);
      l.breakWith(BUSY());
      await l.ticks(1);
    },
    expected: [{ topic: T, state: 'live', consecutiveFailures: 4, lastError: /is locked/ }],
  },
  {
    name: 'a loop that recovered before escalating',
    drive: async (l) => {
      l.breakWith(IOERR());
      await l.ticks(3);
      l.mend();
      await l.ticks(1);
    },
    expected: [{ topic: T, state: 'live', consecutiveFailures: 0 }],
  },
  {
    name: 'a loop that recovered after escalating to degraded',
    drive: async (l) => {
      l.breakWith(IOERR());
      await l.ticks(ESCALATE_AFTER);
      l.mend();
      await l.advance(backoffMs(INTERVAL_MS, ESCALATE_AFTER));
      await l.post('after-recovery');
      await l.ticks(1);
      expect(l.delivered).toEqual(['after-recovery']);
    },
    expected: [{ topic: T, state: 'live', consecutiveFailures: 0 }],
  },
  {
    name: 'a healthy loop that was disconnected',
    drive: async (l) => {
      await l.ticks(2);
      await l.plugin.disconnect();
    },
    expected: [
      { topic: T, state: 'stopped', consecutiveFailures: 0, lastError: /^disconnected$/ },
    ],
  },
  {
    name: 'a degraded loop that was disconnected',
    drive: async (l) => {
      l.breakWith(IOERR());
      await l.ticks(ESCALATE_AFTER);
      await l.plugin.disconnect();
    },
    expected: [
      {
        topic: T,
        state: 'stopped',
        consecutiveFailures: ESCALATE_AFTER,
        lastError: /^disconnected$/,
      },
    ],
  },
];

describe('every subscriptionHealth transition reports every field', () => {
  for (const t of TRANSITIONS) {
    it(t.name, async () => {
      const loop = await startLoop();
      await t.drive(loop);
      expectHealth(loop.plugin.subscriptionHealth(T), t.expected);
    });
  }

  it('a connected plugin reports nothing for a topic it never subscribed', async () => {
    const p = new SqlitePlugin();
    open.push(p);
    await p.connect({ db_path: dbFile(), poll_interval_ms: INTERVAL_MS });
    expectHealth(p.subscriptionHealth(T), []);
    expectHealth(p.subscriptionHealth(), []);
  });

  /**
   * One failing topic must not be reported against another: the report is per loop, and a
   * supervisor restarting the bridge on `lastError` would act on a topic that is perfectly live.
   */
  it('a failure on one topic leaves the other topic’s record untouched', async () => {
    const loop = await startLoop();
    const other = asTopic('other');
    await loop.plugin.subscribe(other, () => {});
    loop.breakWith(IOERR());
    await loop.ticks(3);

    expectHealth(loop.plugin.subscriptionHealth(T), [
      { topic: T, state: 'live', consecutiveFailures: 3, lastError: /disk I\/O/ },
    ]);
    expectHealth(loop.plugin.subscriptionHealth(other), [
      { topic: other, state: 'live', consecutiveFailures: 0 },
    ]);
  });
});

/**
 * The ladder measures DELIVERY, so the only thing that may clear it is a successful read. Driving a
 * sequence of error classes rather than one class per run is what grades that: any tick whose class
 * resets the counters hands a supervisor a loop reporting `live` with zero failures while it has
 * delivered nothing, and re-arms the "first hit is loud" clause the stderr rate limit rests on, so
 * the limit stops holding for every interleaving that touches it.
 *
 * Ticks are advanced one timer at a time, so a row lands on an exact failure count even once the
 * backoff has stretched the interval.
 */
describe('no interleaving of error classes launders the escalation ladder', () => {
  const DIAG_INTERVAL_MS = 60_000;
  const LOCK_BURST = 3;

  const SEQUENCES: Array<{ name: string; at: (nth: number) => Error }> = [
    { name: 'lock on every tick', at: () => BUSY() },
    { name: 'unavailable on every tick', at: () => IOERR() },
    { name: 'lock and unavailable alternating', at: (n) => (n % 2 === 0 ? IOERR() : BUSY()) },
    { name: 'a lock burst then unavailable', at: (n) => (n < LOCK_BURST ? BUSY() : IOERR()) },
    { name: 'unavailable with a single lock inside it', at: (n) => (n === 1 ? BUSY() : IOERR()) },
  ];

  for (const seq of SEQUENCES) {
    for (const n of [ESCALATE_AFTER - 1, ESCALATE_AFTER, 5 * ESCALATE_AFTER]) {
      it(`${seq.name}: ${n} ticks, no successful read`, async () => {
        const loop = await startLoop();
        loop.breakEach(seq.at);
        await loop.post('never-read');

        const startedAt = Date.now();
        await loop.faultedTicks(n);
        const windowMs = Date.now() - startedAt;

        expect(loop.delivered).toEqual([]);
        expectHealth(loop.plugin.subscriptionHealth(T), [
          {
            topic: T,
            state: n >= ESCALATE_AFTER ? 'degraded' : 'live',
            consecutiveFailures: n,
            lastError: new RegExp(escapeRegExp(seq.at(n - 1).message)),
          },
        ]);

        const diags = stderrLines().filter((l) => /poll error/.test(l));
        const classes = Array.from({ length: n }, (_u, i) => classifyDbError(seq.at(i)));
        if (classes.every((c) => c === 'lock')) expect(diags).toEqual([]);
        else expect(diags.length).toBeGreaterThan(0);
        expect(diags.length).toBeLessThanOrEqual(Math.ceil(windowMs / DIAG_INTERVAL_MS) + 1);
      });
    }
  }

  /**
   * The other half of the rate limit: it may not silence the first hit of a NEW outage. A window
   * bound alone is satisfied by writing nothing at all, and the clause that keeps the first hit
   * loud has to key off "nothing diagnosed since the last successful read" — a failure count says
   * the same thing only until a quiet lock tick gets in front of it.
   */
  it('the first unavailable tick after a successful read is loud, even behind a lock burst', async () => {
    const loop = await startLoop();
    const diags = (): string[] => stderrLines().filter((l) => /poll error/.test(l));

    loop.breakEach(() => IOERR());
    await loop.faultedTicks(1);
    expect(diags()).toHaveLength(1);

    loop.mend();
    await loop.ticks(1);

    const recoveredAt = Date.now();
    loop.breakEach((n) => (n < 2 ? BUSY() : IOERR()));
    await loop.faultedTicks(3);

    expect(Date.now() - recoveredAt).toBeLessThan(DIAG_INTERVAL_MS);
    expect(diags()).toHaveLength(2);
  });
});
