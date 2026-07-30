import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlParam } from '../src/driver.js';
import {
  backoffMs,
  MAX_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  POLL_BATCH,
  PRUNE_BATCH,
  SqlitePlugin,
} from '../src/index.js';
import { SQL } from '../src/schema.js';

/**
 * The plugin runs two background jobs — the per-topic poll loop and the retention prune — and both
 * decide, per error, between staying quiet, backing off, and giving up. These cases pin that
 * decision table for every error class rather than for the one class that happened to be tried:
 * a *healable* failure must never end live push, and a non-lock failure must never be silent.
 */

const T = asTopic('ctx');
const me = asHandle('alice');
const dbFile = () => join(mkdtempSync(join(tmpdir(), 'parley-bg-')), 'p.db');

interface ErrorCase {
  name: string;
  make: () => Error;
  /** Whether a burst of this error must leave the loop able to deliver again by itself. */
  healable: boolean;
  /** Lock-classed errors are the sanctioned silent case; everything else must be diagnosed. */
  quiet: boolean;
}

const ERROR_CASES: ErrorCase[] = [
  { name: 'SQLITE_BUSY', make: () => err('database is locked', 'SQLITE_BUSY'), healable: true, quiet: true },
  { name: 'SQLITE_LOCKED', make: () => err('database table is locked', 'SQLITE_LOCKED'), healable: true, quiet: true },
  { name: 'SQLITE_IOERR', make: () => err('disk I/O error', 'SQLITE_IOERR'), healable: true, quiet: false },
  { name: 'SQLITE_CANTOPEN', make: () => err('unable to open database file', 'SQLITE_CANTOPEN'), healable: true, quiet: false },
  { name: 'SQLITE_READONLY', make: () => err('attempt to write a readonly database', 'SQLITE_READONLY'), healable: true, quiet: false },
  { name: 'SQLITE_FULL', make: () => err('database or disk is full', 'SQLITE_FULL'), healable: true, quiet: false },
  { name: 'unclassified', make: () => new Error('something nobody anticipated'), healable: true, quiet: false },
  { name: 'SQLITE_CORRUPT', make: () => err('database disk image is malformed', 'SQLITE_CORRUPT'), healable: false, quiet: false },
  { name: 'no such table', make: () => err('no such table: messages', 'SQLITE_ERROR'), healable: false, quiet: false },
];

function err(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

let open: SqlitePlugin[] = [];
async function plugin(): Promise<SqlitePlugin> {
  const p = new SqlitePlugin();
  await p.connect({ db_path: dbFile(), poll_interval_ms: MIN_POLL_INTERVAL_MS });
  open.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(open.map((p) => p.disconnect()));
  open = [];
});

interface Stmt {
  all(...a: unknown[]): unknown[];
  get(...a: unknown[]): unknown;
  run(...a: unknown[]): unknown;
}

/**
 * Make the poll loop's SELECT throw `e` for the next `failures` ticks, then work again.
 * Returns how many ticks have hit the broken statement so far.
 */
function breakSelect(p: SqlitePlugin, failures: number, e: Error): () => number {
  const holder = p as unknown as { selectAfterStmt: Stmt };
  const real = holder.selectAfterStmt;
  let attempts = 0;
  holder.selectAfterStmt = {
    all: (...a: unknown[]) => {
      if (attempts++ < failures) throw e;
      return real.all(...a);
    },
    get: (...a: unknown[]) => real.get(...a),
    run: (...a: unknown[]) => real.run(...a),
  };
  return () => attempts;
}

// A burst long enough to cross the escalation threshold with room to spare, so the "keeps probing
// past escalation" behaviour — not just "tolerates a few misses" — is what is being measured.
const BURST = 13;

describe('poll loop error-class matrix', () => {
  for (const c of ERROR_CASES) {
    it(`${c.name}: a burst of ${BURST} then recovery ${c.healable ? 'still delivers' : 'stops the loop'}`, async () => {
      const p = await plugin();
      const got: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await p.subscribe(T, (m) => got.push(m.content));
        const attempts = breakSelect(p, BURST, c.make());

        if (c.healable) {
          await vi.waitFor(() => expect(attempts()).toBeGreaterThanOrEqual(BURST), {
            timeout: 8000,
            interval: 5,
          });
          await p.post(T, me, 'after-recovery');
          await vi.waitFor(() => expect(got).toEqual(['after-recovery']), {
            timeout: 8000,
            interval: 10,
          });
          expect(p.subscriptionHealth(T)[0]?.state).toBe('live');
        } else {
          await vi.waitFor(() => expect(p.subscriptionHealth(T)[0]?.state).toBe('stopped'), {
            timeout: 3000,
            interval: 5,
          });
          await p.post(T, me, 'after-recovery');
          await new Promise((r) => setTimeout(r, 100));
          expect(got).toEqual([]);
        }
      } finally {
        spy.mockRestore();
      }
    });

    it(`${c.name}: a persistent failure is ${c.quiet ? 'silent' : 'diagnosed'} on stderr`, async () => {
      const p = await plugin();
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let lines: string[] = [];
      try {
        await p.subscribe(T, () => {});
        breakSelect(p, Number.POSITIVE_INFINITY, c.make());
        await vi.waitFor(
          () => {
            lines = spy.mock.calls.map(([l]) => String(l));
            expect(c.quiet ? true : lines.some((l) => /poll error/.test(l))).toBe(true);
            expect(p.subscriptionHealth(T)[0]).toBeDefined();
          },
          { timeout: 3000, interval: 5 },
        );
        // Give the loop time to run well past the escalation threshold either way.
        await new Promise((r) => setTimeout(r, 200));
        lines = spy.mock.calls.map(([l]) => String(l));
      } finally {
        spy.mockRestore();
      }
      const diags = lines.filter((l) => /poll error|poll loop/.test(l));
      if (c.quiet) {
        expect(diags).toEqual([]);
        expect(p.subscriptionHealth(T)[0]?.state).toBe('live');
      } else {
        expect(diags.length).toBeGreaterThan(0);
        // Rate-limited: a persistent failure must not write one line per poll interval.
        expect(diags.length).toBeLessThanOrEqual(3);
        expect(p.subscriptionHealth(T)[0]?.state).toBe(c.healable ? 'degraded' : 'stopped');
        expect(p.subscriptionHealth(T)[0]?.lastError).toContain(c.make().message);
      }
    });
  }
});

/**
 * The degraded loop keeps probing forever, so its delay is the only thing bounding how long a topic
 * whose store was briefly unreachable stays dark. The README promises 30 s. Every expectation here
 * is a literal rather than a re-derivation from the constant, so raising or removing the ceiling —
 * which the error-class matrix above cannot see, since a 13-failure burst never reaches it — turns
 * this table red instead of shipping a multi-day recovery.
 */
describe('the degraded poll delay is bounded by the documented ceiling', () => {
  const CEILING_MS = 30_000;

  const DELAYS: Array<{ pollIntervalMs: number; failures: number; expected: number }> = [
    { pollIntervalMs: MIN_POLL_INTERVAL_MS, failures: 10, expected: 20 },
    { pollIntervalMs: MIN_POLL_INTERVAL_MS, failures: 14, expected: 320 },
    { pollIntervalMs: 1000, failures: 10, expected: 2000 },
    { pollIntervalMs: 1000, failures: 13, expected: 16_000 },
    { pollIntervalMs: 1000, failures: 14, expected: CEILING_MS },
    { pollIntervalMs: 1000, failures: 40, expected: CEILING_MS },
    { pollIntervalMs: 1000, failures: 1000, expected: CEILING_MS },
    { pollIntervalMs: 60_000, failures: 10, expected: CEILING_MS },
    { pollIntervalMs: MAX_POLL_INTERVAL_MS, failures: 11, expected: CEILING_MS },
  ];

  for (const { pollIntervalMs, failures, expected } of DELAYS) {
    it(`${pollIntervalMs} ms interval after ${failures} failures waits ${expected} ms`, () => {
      expect(backoffMs(pollIntervalMs, failures)).toBe(expected);
    });
  }

  it('never decreases as failures accumulate, and never exceeds the ceiling', () => {
    for (const pollIntervalMs of [MIN_POLL_INTERVAL_MS, 250, 1000, MAX_POLL_INTERVAL_MS]) {
      const series = Array.from({ length: 60 }, (_u, i) => backoffMs(pollIntervalMs, i + 10));
      expect(series).toEqual([...series].sort((a, b) => a - b));
      expect(Math.max(...series)).toBeLessThanOrEqual(CEILING_MS);
      expect(Math.min(...series)).toBeGreaterThan(0);
    }
  });
});

describe('retention prune error visibility', () => {
  for (const c of ERROR_CASES) {
    it(`${c.name}: a failing prune is ${c.quiet ? 'silent' : 'diagnosed'}`, async () => {
      const p = new SqlitePlugin();
      open.push(p);
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let lines: string[] = [];
      try {
        await p.connect({
          db_path: dbFile(),
          poll_interval_ms: MIN_POLL_INTERVAL_MS,
          retention_days: 30,
        });
        const holder = p as unknown as { pruneStmt: Stmt; prune(): void };
        holder.pruneStmt = {
          all: () => [],
          get: () => undefined,
          run: () => {
            throw c.make();
          },
        };
        holder.prune();
        lines = spy.mock.calls.map(([l]) => String(l));
      } finally {
        spy.mockRestore();
      }
      const diags = lines.filter((l) => /retention prune failed/.test(l));
      expect(diags.length).toBe(c.quiet ? 0 : 1);
      if (!c.quiet) expect(diags[0]).toContain(c.make().message);
    });
  }
});

/**
 * Both background jobs run synchronous statements against a file that peers are writing. Work
 * that scales with the store — an unindexed scan, an unbounded delete — holds the single write
 * lock and the event loop for that whole span, and past a peer's busy_timeout their `post()`
 * throws SQLITE_BUSY: the one failure WAL + busy_timeout are advertised to prevent.
 */
describe('background jobs do bounded work per statement', () => {
  async function fill(p: SqlitePlugin, topic = T, rows = 1): Promise<void> {
    for (let i = 0; i < rows; i++) await p.post(topic, me, `m${i}`);
  }

  /**
   * Planned from `SQL` — the same map `connect()` prepares from — so that the statement this grades
   * is the statement that runs. A plan check against SQL restated in the test certifies a copy, and
   * every degradation it exists to catch (a predicate the index cannot serve, a dropped LIMIT
   * subquery, a reordered term) ships green.
   */
  const PLANNED: Array<{ name: keyof typeof SQL; params: SqlParam[]; index: RegExp | null }> = [
    { name: 'selectAfter', params: [T, 0, POLL_BATCH], index: /idx_messages_topic_id/ },
    { name: 'selectRecent', params: [T, 100], index: /idx_messages_topic_id/ },
    { name: 'maxId', params: [T], index: /idx_messages_topic_id/ },
    { name: 'prune', params: [new Date().toISOString(), PRUNE_BATCH], index: /idx_messages_ts/ },
    { name: 'seq', params: [], index: null },
  ];
  const NO_PLAN: Array<keyof typeof SQL> = ['insert'];

  it('every statement the plugin prepares is either planned below or an insert', () => {
    expect([...PLANNED.map((s) => s.name), ...NO_PLAN].sort()).toEqual(Object.keys(SQL).sort());
  });

  for (const { name, params, index } of PLANNED) {
    it(`${name} resolves through an index, not a table scan`, async () => {
      const p = await plugin();
      await fill(p, T, 50);
      const holder = p as unknown as { driver: { prepare(sql: string): Stmt } };
      const plan = holder.driver.prepare(`EXPLAIN QUERY PLAN ${SQL[name]}`).all(...params) as Array<{
        detail: string;
      }>;
      const steps = plan.map((r) => r.detail);
      const onMessages = steps.filter((s) => /\bmessages\b/.test(s));
      if (index === null) {
        expect(onMessages).toEqual([]);
        return;
      }
      // Keep this matching on SEARCH rather than on the index name, so that a COVERING INDEX *scan*
      // — which still walks the whole store — cannot pass as index use.
      expect(onMessages.length).toBeGreaterThan(0);
      for (const step of onMessages) {
        expect(step).toMatch(/^SEARCH messages USING (COVERING INDEX|INDEX|INTEGER PRIMARY KEY)/);
      }
      expect(steps.join(' | ')).toMatch(index);
    });
  }

  it('a prune larger than one batch yields to the event loop between batches', async () => {
    const path = dbFile();
    const writer = new SqlitePlugin();
    await writer.connect({ db_path: path, poll_interval_ms: 20 });
    const rows = 2 * PRUNE_BATCH + 100;
    const stmt = (writer as unknown as { insertStmt: Stmt }).insertStmt;
    const old = new Date(Date.now() - 86_400_000).toISOString();
    for (let i = 0; i < rows; i++) stmt.run(T, me, `m${i}`, old, null);
    await writer.disconnect();

    let ticks = 0;
    const beat = setInterval(() => ticks++, 2);
    const p = new SqlitePlugin();
    open.push(p);
    await p.connect({ db_path: path, poll_interval_ms: 20, retention_days: 1 / 24 });

    await vi.waitFor(
      async () => {
        const { messages } = await p.fetchRecent({ topic: T, limit: 1 });
        expect(messages).toEqual([]);
      },
      { timeout: 8000, interval: 10 },
    );
    clearInterval(beat);
    // Batches are separate turns of the loop, so the heartbeat ran while the store was draining.
    expect(ticks).toBeGreaterThan(0);
  });
});

/**
 * `poll_interval_ms` is documented as a pure latency knob. It stops being one if a tick that fills
 * its batch then waits a whole interval: throughput would be capped at POLL_BATCH per interval and
 * a producer above that falls behind without bound, silently.
 */
describe('a full poll batch reschedules immediately', () => {
  for (const backlog of [POLL_BATCH - 1, POLL_BATCH, 3 * POLL_BATCH]) {
    it(`delivers a backlog of ${backlog} within one poll interval`, async () => {
      const interval = 1500;
      const p = new SqlitePlugin();
      open.push(p);
      await p.connect({ db_path: dbFile(), poll_interval_ms: interval });

      const got: string[] = [];
      await p.subscribe(T, (m) => got.push(m.content));

      const stmt = (p as unknown as { insertStmt: Stmt }).insertStmt;
      const ts = new Date().toISOString();
      const expected = Array.from({ length: backlog }, (_u, i) => `m${i}`);
      for (const c of expected) stmt.run(T, me, c, ts, null);

      const started = Date.now();
      await vi.waitFor(() => expect(got).toHaveLength(backlog), { timeout: 10_000, interval: 20 });
      expect(got).toEqual(expected);
      expect(Date.now() - started).toBeLessThan(2 * interval);
    });
  }
});
