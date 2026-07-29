import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asBackendMsgId,
  asHandle,
  asTopic,
  catchUpTopic,
  type Cursor,
  ReadStateStore,
  SeenSet,
  type Topic,
} from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDriver } from './driver.js';
import { MAX_PAGE, MIN_POLL_INTERVAL_MS, SqlitePlugin } from './index.js';

const T = asTopic('ctx');
const me = asHandle('alice');
const ONE_MS_IN_DAYS = 1 / 86_400_000;
const dbFile = () => join(mkdtempSync(join(tmpdir(), 'parley-sqlite-')), 'p.db');

let open: SqlitePlugin[] = [];
async function plugin(pollMs = 10): Promise<SqlitePlugin> {
  const p = new SqlitePlugin();
  await p.connect({ db_path: dbFile(), poll_interval_ms: pollMs });
  open.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(open.map((p) => p.disconnect()));
  open = [];
});

function seedRows(p: SqlitePlugin, topic: Topic, rows: number): void {
  if (rows === 0) return;
  (p as unknown as { driver: SqlDriver }).driver
    .prepare(
      'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?) ' +
        "INSERT INTO messages (topic, sender, content, ts) SELECT ?, ?, 'm' || n, ? FROM seq",
    )
    .run(rows, topic, me, '2024-01-01T00:00:00.000Z');
}

/** Plant one row at an explicit rowid, so the AUTOINCREMENT sequence continues from there. */
function seedRowAt(p: SqlitePlugin, topic: Topic, id: number): void {
  (p as unknown as { driver: SqlDriver }).driver
    .prepare('INSERT INTO messages (id, topic, sender, content, ts) VALUES (?, ?, ?, ?, ?)')
    .run(String(id), topic, me, 'seeded', '2024-01-01T00:00:00.000Z');
}

const expectedRows = (rows: number): string[] =>
  Array.from({ length: rows }, (_unused, i) => `m${i + 1}`);

const coldCursor = async (p: SqlitePlugin): Promise<Cursor> =>
  (await p.fetchRecent({ topic: asTopic('never-posted') })).nextCursor;

type DrainOutcome =
  | { kind: 'rejected'; message: string }
  | { kind: 'drained'; contents: string[] };

/**
 * Page a topic with the stop rule every caller uses, core's `catchUpTopic` included: a page
 * shorter than the requested `limit` means the topic is exhausted.
 */
async function drainStoppingOnShortPage(
  p: SqlitePlugin,
  topic: Topic,
  limit: number,
): Promise<DrainOutcome> {
  let since = await coldCursor(p);
  const contents: string[] = [];
  for (let page = 0; page < 5_000; page++) {
    let res;
    try {
      res = await p.fetchRecent({ topic, since, limit });
    } catch (e) {
      return { kind: 'rejected', message: e instanceof Error ? e.message : String(e) };
    }
    contents.push(...res.messages.map((m) => m.content));
    if (res.messages.length < limit || res.nextCursor === since) return { kind: 'drained', contents };
    since = res.nextCursor;
  }
  throw new Error(`draining ${topic} with limit ${limit} did not terminate`);
}

/**
 * The seam contract itself is graded by the shared suite (test/conformance.test.ts runs it against
 * this exact plugin), so nothing here restates it. What is left is what is true of THIS backend and
 * false of others: a bare-rowid `backendMsgId`, a `<storeId>.<rowid>` cursor, a handle that is a
 * naming convention rather than a provisioned account, and the retention timer.
 */
describe('SqlitePlugin identifiers are rowid-shaped', () => {
  it('backendMsgId is the bare rowid and the cursor carries the store id', async () => {
    const p = await plugin();
    const id1 = await p.post(T, me, 'hello @bob');
    const id2 = await p.post(T, me, 'second');
    expect([id1, id2]).toEqual(['1', '2']);

    const { messages, nextCursor } = await p.fetchRecent({ topic: T });
    expect(messages.map((m) => m.backendMsgId)).toEqual(['1', '2']);
    expect(messages[0]!.cursor).toMatch(/^[0-9a-f]{16}\.1$/);
    expect(messages[1]!.cursor).toMatch(/^[0-9a-f]{16}\.2$/);
    expect(nextCursor).toBe(messages[1]!.cursor);
  });

  /**
   * A rowid the store can hold has to mean the same thing to `post()`, to `fetchRecent()` and to
   * the cursor: post's id is the dedup key core drops duplicates on, and the cursor is the `id >`
   * bound catch-up resumes from, so a value that survives one path and not the other is silent loss
   * or endless replay. Both carry the rowid through a JS number, so the supported range ends at
   * Number.MAX_SAFE_INTEGER — this table is where that boundary is stated and checked.
   */
  const ROWIDS = [1, 2 ** 31, Number.MAX_SAFE_INTEGER - 1];

  for (const seeded of ROWIDS) {
    it(`a row at rowid ${seeded} round-trips through post, fetchRecent and the cursor`, async () => {
      const p = await plugin();
      seedRowAt(p, T, seeded);
      const posted = await p.post(T, me, 'after');

      const { messages } = await p.fetchRecent({ topic: T });
      expect(messages.map((m) => m.backendMsgId)).toEqual([String(seeded), posted]);
      expect(messages.map((m) => m.content)).toEqual(['seeded', 'after']);
      expect(messages[1]!.cursor.endsWith(`.${posted}`)).toBe(true);

      const drained = await p.fetchRecent({ topic: T, since: messages[1]!.cursor });
      expect(drained.messages).toEqual([]);
    });
  }

  it('resolveIdentity treats a handle as a naming convention, not a provisioned account', async () => {
    const p = await plugin();
    expect(await p.resolveIdentity(asHandle('ctx-payments'))).toEqual({
      handle: 'ctx-payments',
      backendRef: 'ctx-payments',
    });
  });
});

describe('SqlitePlugin retention_days', () => {
  it('prunes older rows on connect, without breaking cursor monotonicity', async () => {
    const path = dbFile();
    const writer = new SqlitePlugin();
    await writer.connect({ db_path: path, poll_interval_ms: 10 });
    await writer.post(T, me, 'old-1');
    const lastOldId = await writer.post(T, me, 'old-2');
    await writer.disconnect();

    // A sub-millisecond window puts the cutoff just after the posts above → prunable immediately.
    await new Promise((r) => setTimeout(r, 5));
    const p = new SqlitePlugin();
    open.push(p);
    await p.connect({ db_path: path, poll_interval_ms: 10, retention_days: ONE_MS_IN_DAYS });

    await vi.waitFor(
      async () => {
        const { messages } = await p.fetchRecent({ topic: T });
        expect(messages).toEqual([]);
      },
      { timeout: 2000, interval: 10 },
    );

    // AUTOINCREMENT never reuses ids, so the next post's cursor still strictly increases.
    const id3 = await p.post(T, me, 'new-after-prune');
    expect(Number(id3)).toBeGreaterThan(Number(lastOldId));
  });

  /**
   * The prune interval is the plugin's only long-lived timer, and three things about it are load
   * bearing: its cadence (a window nobody re-prunes is a retention policy the operator believes is
   * enforced), `.unref()` (a leaked plugin must not pin the event loop by itself), and that
   * `disconnect()` clears it (otherwise it keeps firing against a closed store forever).
   */
  it('creates the prune timer hourly, unref()d, and clears it on disconnect', async () => {
    const created: Array<{ timer: ReturnType<typeof setInterval>; ms: number | undefined }> = [];
    const cleared: Array<unknown> = [];
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        const timer = realSetInterval(fn, ms, ...args);
        created.push({ timer, ms });
        return timer;
      }) as typeof setInterval);
    const clearSpy = vi
      .spyOn(globalThis, 'clearInterval')
      .mockImplementation(((t: Parameters<typeof clearInterval>[0]) => {
        cleared.push(t);
        realClearInterval(t);
      }) as typeof clearInterval);
    try {
      const p = new SqlitePlugin();
      open.push(p);
      await p.connect({ db_path: dbFile(), poll_interval_ms: 10, retention_days: 7 });
      // The prune interval is the only setInterval the plugin creates (the poll loop uses
      // setTimeout).
      expect(created.map((c) => c.ms)).toEqual([60 * 60 * 1000]);
      // hasRef() === false ⟺ .unref() was applied — the timer will not keep the process alive.
      expect(created.every((c) => c.timer.hasRef() === false)).toBe(true);

      await p.disconnect();
      expect(cleared).toEqual(created.map((c) => c.timer));
    } finally {
      spy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});


/**
 * `inReplyTo` is the seam's only threading argument, and a `Message` carries no reply field, so
 * nothing above the driver can observe whether it was stored. Read the row back, or a dropped bind
 * is indistinguishable from a persisted one — and the human reading the file sees a flat log.
 */
describe('SqlitePlugin post persists inReplyTo', () => {
  const rawReplyTo = (p: SqlitePlugin, id: string): string | null =>
    (
      (p as unknown as { driver: SqlDriver }).driver
        .prepare('SELECT in_reply_to FROM messages WHERE id = ?')
        .get(id) as { in_reply_to: string | null }
    ).in_reply_to;

  for (const parent of [undefined, '1']) {
    it(`a post with inReplyTo ${String(parent)} stores exactly that`, async () => {
      const p = await plugin();
      await p.post(T, me, 'parent');
      const opts = parent === undefined ? undefined : { inReplyTo: asBackendMsgId(parent) };
      const child = await p.post(T, me, 'child', opts);
      expect(rawReplyTo(p, child)).toBe(parent ?? null);
    });
  }
});

/**
 * `limit` reaches `fetchRecent` from a model whose context is untrusted inbound message content,
 * on a synchronous driver. A value it cannot serve must be refused — never absorbed as "no limit"
 * (how SQLite reads a negative LIMIT), and never quietly served short: every caller that pages,
 * core's `catchUpTopic` included, reads a page shorter than the `limit` it asked for as "topic
 * exhausted", so a silent server-side cap strands the remainder for the rest of the session.
 */
describe('SqlitePlugin fetchRecent limit', () => {
  const REJECTED = [-1, 0, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '10', null];

  for (const limit of REJECTED) {
    it(`rejects ${String(limit)} with a parley-sqlite error naming it`, async () => {
      const p = await plugin();
      await p.post(T, me, 'a');
      await expect(
        p.fetchRecent({ topic: T, limit: limit as unknown as number }),
      ).rejects.toThrow(/parley-sqlite: invalid limit/);
    });
  }

  it('no limit serves the newest DEFAULT_PAGE window', async () => {
    const p = await plugin();
    seedRows(p, T, 250);
    const { messages } = await p.fetchRecent({ topic: T });
    expect(messages).toHaveLength(100);
    expect(messages.at(-1)?.content).toBe('m250');
  });

  /**
   * The contract, over (stored rows x requested limit): a limit this backend will not serve is
   * REJECTED with an error naming the ceiling, and any limit it does accept drains the topic
   * COMPLETELY under the stop-on-short-page rule. Neither outcome can strand a message, and no
   * future ceiling — larger, smaller, or reinstated as a clamp — can pass this table silently.
   */
  const STORED = [0, 1, 7];
  const LIMITS = [1, 2, 7, 8, 100, MAX_PAGE - 1, MAX_PAGE, MAX_PAGE + 1, 1e6, Number.MAX_SAFE_INTEGER];
  const VOLUME_STORED = [MAX_PAGE, MAX_PAGE + 1, 2 * MAX_PAGE + 3];
  const VOLUME_LIMITS = [MAX_PAGE, MAX_PAGE + 1, 1e6];

  const cases = [
    ...STORED.flatMap((rows) => LIMITS.map((limit) => ({ rows, limit }))),
    ...VOLUME_STORED.flatMap((rows) => VOLUME_LIMITS.map((limit) => ({ rows, limit }))),
  ];

  for (const { rows, limit } of cases) {
    it(`${rows} stored rows read with limit ${limit} either reject loudly or drain whole`, async () => {
      const p = await plugin();
      seedRows(p, T, rows);
      const outcome = await drainStoppingOnShortPage(p, T, limit);

      if (outcome.kind === 'rejected') {
        expect(outcome.message).toMatch(/parley-sqlite: invalid limit/);
        expect(outcome.message).toContain(String(MAX_PAGE));
        // The operator's lever, not just the plugin's ceiling: this rejection is reached from a
        // core config key and from a tool argument, and naming neither leaves "lower it where?"
        // answerable only by reading plugin source.
        expect(outcome.message).toContain('catchup.limit');
        expect(outcome.message).toContain('parley_fetch_recent');
        expect(limit).toBeGreaterThan(MAX_PAGE);
        return;
      }
      expect(outcome.contents).toEqual(expectedRows(rows));
    });
  }

  it("core's catch-up over a limit no backend caps at drains every stored message", async () => {
    const p = await plugin();
    const rows = 2 * MAX_PAGE + 5;
    seedRows(p, T, rows);
    const readState = new ReadStateStore(join(mkdtempSync(join(tmpdir(), 'parley-rs-')), 's.json'));
    readState.set(T, await coldCursor(p));

    const run = catchUpTopic({ plugin: p, topic: T, limit: MAX_PAGE + 1, readState, seen: new SeenSet() });
    const settled = await run.then(
      (total) => ({ total }),
      (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }),
    );

    if ('error' in settled) {
      expect(settled.error).toMatch(/parley-sqlite: invalid limit/);
      return;
    }
    expect(settled.total).toBe(rows);
  });
});

describe('SqlitePlugin poll-loop diagnostics', () => {
  it('diagnoses a permanently-failing poll tick and stops the loop after N failures', async () => {
    const p = await plugin(MIN_POLL_INTERVAL_MS); // fast poll so escalation is quick
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let lines: string[] = [];
    try {
      await p.subscribe(T, () => {});
      // Induce a PERMANENT (non-transient) failure under the running loop: drop the table so every
      // subsequent tick's SELECT throws "no such table: messages" identically.
      (p as unknown as { driver: { exec(sql: string): void } }).driver.exec('DROP TABLE messages');
      await vi.waitFor(
        () => {
          lines = spy.mock.calls.map(([c]) => String(c));
          // Escalation: the loop stops itself rather than spinning silently forever.
          expect(lines.some((w) => /poll loop for topic "ctx" stopped/.test(w))).toBe(true);
        },
        { timeout: 3000, interval: 10 },
      );
    } finally {
      spy.mockRestore();
    }

    // Not silent — a diagnostic names the failing topic (pre-fix the catch was empty).
    expect(lines.some((w) => /poll error on topic "ctx"/.test(w))).toBe(true);
    // Rate-limited — NOT one line per tick: only the first hard failure logs (the rest are
    // suppressed until the 60 s window), so at most a couple of "poll error" lines, not dozens.
    const diag = lines.filter((w) => /poll error on topic "ctx"/.test(w));
    expect(diag.length).toBeLessThanOrEqual(2);

    // Stopped means stopped: no reschedule → no further ticks → no further stderr writes.
    const spy2 = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await new Promise((r) => setTimeout(r, 60));
    const wroteAfterStop = spy2.mock.calls.length;
    spy2.mockRestore();
    expect(wroteAfterStop).toBe(0);
  });

  it('takes the quiet-retry path for a SQLITE_BUSY/LOCKED tick — no diagnostic, keeps ticking', async () => {
    const p = await plugin(MIN_POLL_INTERVAL_MS);
    const busyErr = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    let calls = 0;
    // Swap in a statement whose .all always throws a lock-classed error, as WAL contention would.
    (
      p as unknown as { selectAfterStmt: { all: (...a: unknown[]) => unknown[] } }
    ).selectAfterStmt = {
      all: () => {
        calls++;
        throw busyErr;
      },
    };
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let wrote: string[] = [];
    try {
      await p.subscribe(T, () => {});
      // A transient lock never escalates, so the loop keeps ticking — `calls` climbs past several.
      await vi.waitFor(() => expect(calls).toBeGreaterThan(3), { timeout: 2000, interval: 10 });
      wrote = spy.mock.calls.map(([c]) => String(c));
    } finally {
      spy.mockRestore();
    }
    // Quiet: a lock-classed error writes NO diagnostic and never stops the loop.
    expect(wrote.some((w) => /poll error|poll loop/.test(w))).toBe(false);
  });
});
