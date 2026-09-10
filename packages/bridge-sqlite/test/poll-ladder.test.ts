import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffMs, classifyDbError, ESCALATE_AFTER, SqlitePlugin } from '../src/index.js';

/**
 * The escalation ladder, graded on the only thing an operator or core can observe from outside the
 * plugin: whether the loop still DELIVERS. A tick that read nothing delivered nothing, contention
 * included, so a run of failures past the threshold backs the loop off while it keeps probing, and
 * only unrecoverable damage stops it for good.
 *
 * Driven on fake timers so each row lands on an exact failure count rather than a raced one.
 */

const T = asTopic('ctx');
const me = asHandle('alice');
const INTERVAL_MS = 1000;
const dbFile = () => join(mkdtempSync(join(tmpdir(), 'parley-ladder-')), 'p.db');

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
  /** How many times the loop has read the store, faulted or not. */
  reads(): number;
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
  let reads = 0;
  holder.selectAfterStmt = {
    // Faulted for THIS topic only, so a second subscription on the same statement stays healthy.
    all: (...a: unknown[]) => {
      if (a[0] === T) reads++;
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
    reads: () => reads,
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

/**
 * `resumes` is what the ladder promises after the drive: a loop at full cadence delivers the next
 * message within one poll interval, a backed-off one only after the backoff, and a stopped one
 * never. Grading all three against the SAME probe is what keeps "backed off" from reading as
 * "healthy" — the difference between them is entirely a matter of when.
 */
const RESUMES = ['at once', 'after the backoff', 'never'] as const;
type Resumes = (typeof RESUMES)[number];

const PROBE = 'after-the-drive';

/**
 * Every row posts {@link PROBE} itself, as its last act while still connected: a torn-down plugin
 * refuses `post`, and a probe the harness planted afterwards would grade the refusal rather than
 * the loop.
 */
const LADDER: Array<{ name: string; drive: (loop: Loop) => Promise<void>; resumes: Resumes }> = [
  { name: 'a loop that has just been armed', drive: (l) => l.post(PROBE), resumes: 'at once' },
  {
    name: 'a loop that has polled quietly',
    drive: async (l) => {
      await l.ticks(5);
      await l.post(PROBE);
    },
    resumes: 'at once',
  },
  {
    name: 'a non-lock failure one tick below the escalation threshold',
    drive: async (l) => {
      l.breakWith(IOERR());
      await l.ticks(ESCALATE_AFTER - 1);
      l.mend();
      await l.post(PROBE);
    },
    resumes: 'at once',
  },
  {
    name: 'a healable failure at the escalation threshold',
    drive: async (l) => {
      l.breakWith(IOERR());
      await l.ticks(ESCALATE_AFTER);
      l.mend();
      await l.post(PROBE);
    },
    resumes: 'after the backoff',
  },
  {
    name: 'a lock burst that carries a run of non-lock failures over the threshold',
    drive: async (l) => {
      l.breakWith(IOERR());
      await l.ticks(ESCALATE_AFTER - 1);
      l.breakWith(BUSY());
      await l.ticks(1);
      l.mend();
      await l.post(PROBE);
    },
    resumes: 'after the backoff',
  },
  {
    name: 'a fatal failure at the escalation threshold',
    drive: async (l) => {
      l.breakWith(CORRUPT());
      await l.ticks(ESCALATE_AFTER);
      l.mend();
      await l.post(PROBE);
    },
    resumes: 'never',
  },
  {
    name: 'a healthy loop that was disconnected',
    drive: async (l) => {
      await l.ticks(2);
      await l.post(PROBE);
      await l.plugin.disconnect();
    },
    resumes: 'never',
  },
  {
    name: 'a degraded loop that was disconnected',
    drive: async (l) => {
      l.breakWith(IOERR());
      await l.ticks(ESCALATE_AFTER);
      l.mend();
      await l.post(PROBE);
      await l.plugin.disconnect();
    },
    resumes: 'never',
  },
];

describe('what the escalation ladder does to delivery', () => {
  for (const row of LADDER) {
    it(`${row.name}: resumes ${row.resumes}`, async () => {
      const loop = await startLoop();
      await row.drive(loop);

      await loop.ticks(1);
      expect(loop.delivered.includes(PROBE)).toBe(row.resumes === 'at once');

      await loop.advance(backoffMs(INTERVAL_MS, ESCALATE_AFTER) + INTERVAL_MS);
      expect(loop.delivered.includes(PROBE)).toBe(row.resumes !== 'never');

      // A stopped loop is stopped for good, not merely slow: nothing reaches the handler however
      // long the store has been well again.
      await loop.advance(10 * 60_000);
      expect(loop.delivered.includes(PROBE)).toBe(row.resumes !== 'never');
    });
  }

  /**
   * One failing topic must not take another down: `subscribe` starts an independent loop per call,
   * and a store fault scoped to one topic's read leaves the other one delivering at full cadence.
   */
  it('a failure on one topic leaves the other topic delivering', async () => {
    const loop = await startLoop();
    const other = asTopic('other');
    const elsewhere: string[] = [];
    await loop.plugin.subscribe(other, (m) => elsewhere.push(m.content));
    loop.breakWith(IOERR());
    await loop.ticks(3);

    await loop.post('to-the-broken-topic');
    await loop.plugin.post(other, me, 'to-the-healthy-topic');
    await loop.ticks(1);

    expect(loop.delivered).toEqual([]);
    expect(elsewhere).toEqual(['to-the-healthy-topic']);
  });
});

/**
 * The ladder measures DELIVERY, so the only thing that may clear it is a successful read. Driving a
 * sequence of error classes rather than one class per run is what grades that: any tick whose class
 * resets the counters leaves a loop that has delivered nothing polling at full rate, and re-arms the
 * "first hit is loud" clause the stderr rate limit rests on, so the limit stops holding for every
 * interleaving that touches it.
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

        // Past the threshold the loop is backed off, whatever the interleaving: the message it
        // could not read is still not delivered a full poll interval after the store is well.
        loop.mend();
        await loop.ticks(1);
        expect(loop.delivered).toEqual(n >= ESCALATE_AFTER ? [] : ['never-read']);
        await loop.advance(backoffMs(INTERVAL_MS, n) + INTERVAL_MS);
        expect(loop.delivered).toEqual(['never-read']);

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

  /**
   * Only unrecoverable damage may end the loop, and when it does it says so: everything else keeps
   * being probed forever, so a topic whose store was briefly unreachable is never dark for good.
   */
  const PROBING: Array<[name: string, make: () => Error, probes: boolean]> = [
    ['a healable failure keeps being probed', IOERR, true],
    ['unrecoverable damage ends the loop, and says so', CORRUPT, false],
  ];

  it.each(PROBING)('%s', async (_name, make, probes) => {
    const loop = await startLoop();
    loop.breakWith(make());
    await loop.ticks(ESCALATE_AFTER);

    const before = loop.reads();
    await loop.advance(backoffMs(INTERVAL_MS, ESCALATE_AFTER) * 3);
    expect(loop.reads() > before).toBe(probes);
    expect(stderrLines().some((l) => new RegExp(escapeRegExp('stopped after')).test(l))).toBe(
      !probes,
    );
  });
});
