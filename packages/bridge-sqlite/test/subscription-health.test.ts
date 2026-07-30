import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffMs, ESCALATE_AFTER, SqlitePlugin } from '../src/index.js';
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
  mend(): void;
  post(content: string): Promise<void>;
  advance(ms: number): Promise<void>;
  ticks(n: number): Promise<void>;
}

let open: SqlitePlugin[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
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
  let fault: Error | undefined;
  holder.selectAfterStmt = {
    // Faulted for THIS topic only, so a second subscription on the same statement stays healthy.
    all: (...a: unknown[]) => {
      if (fault !== undefined && a[0] === T) throw fault;
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
      fault = e;
    },
    mend: () => {
      fault = undefined;
    },
    post: async (content) => {
      await plugin.post(T, me, content);
    },
    advance,
    ticks: (n) => advance(n * INTERVAL_MS),
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
    name: 'a lock-classed tick after a burst of non-lock failures',
    drive: async (l) => {
      l.breakWith(IOERR());
      await l.ticks(3);
      l.breakWith(BUSY());
      await l.ticks(1);
    },
    expected: [{ topic: T, state: 'live', consecutiveFailures: 0 }],
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
