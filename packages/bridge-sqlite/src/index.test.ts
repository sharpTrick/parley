import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('SqlitePlugin (seam smoke)', () => {
  it('post → fetchRecent returns the message with a monotonic cursor', async () => {
    const p = await plugin();
    const id1 = await p.post(T, me, 'hello @bob');
    const id2 = await p.post(T, me, 'second');
    expect(id1).toBe('1');
    expect(id2).toBe('2');

    const { messages, nextCursor } = await p.fetchRecent({ topic: T });
    expect(messages.map((m: Message) => m.content)).toEqual(['hello @bob', 'second']);
    expect(messages[0]!.cursor).toMatch(/^[0-9a-f]{16}\.1$/);
    expect(messages[1]!.cursor).toMatch(/^[0-9a-f]{16}\.2$/);
    expect(messages[0]!.backendMsgId).toBe('1');
    expect(messages[0]!.mentions).toEqual(['bob']);
    expect(nextCursor).toBe(messages[1]!.cursor);
  });

  it('fetchRecent({since}) is exclusive — only newer', async () => {
    const p = await plugin();
    await p.post(T, me, 'a');
    await p.post(T, me, 'b');
    const all = await p.fetchRecent({ topic: T });
    const after = await p.fetchRecent({ topic: T, since: all.messages[0]!.cursor });
    expect(after.messages.map((m: Message) => m.content)).toEqual(['b']);
    expect(after.nextCursor).toBe(all.nextCursor);

    const drained = await p.fetchRecent({ topic: T, since: after.nextCursor });
    expect(drained.messages).toEqual([]);
    expect(drained.nextCursor).toBe(all.nextCursor);
  });

  it('topics are isolated', async () => {
    const p = await plugin();
    const A = asTopic('a');
    const B = asTopic('b');
    await p.post(A, me, 'in-a');
    await p.post(B, me, 'in-b');
    expect((await p.fetchRecent({ topic: A })).messages.map((m) => m.content)).toEqual(['in-a']);
    expect((await p.fetchRecent({ topic: B })).messages.map((m) => m.content)).toEqual(['in-b']);
  });

  it('subscribe (poll loop) delivers new posts in order and skips history', async () => {
    const p = await plugin();
    await p.post(T, me, 'old'); // before subscribe → must NOT be pushed
    const got: string[] = [];
    await p.subscribe(T, (m) => got.push(m.content));
    await p.post(T, me, 'new-1');
    await p.post(T, me, 'new-2');
    await vi.waitFor(() => expect(got).toEqual(['new-1', 'new-2']), { timeout: 2000, interval: 5 });
  });

  it('resolveIdentity uses the string convention', async () => {
    const p = await plugin();
    expect(await p.resolveIdentity(asHandle('ctx-payments'))).toEqual({
      handle: 'ctx-payments',
      backendRef: 'ctx-payments',
    });
  });

  it('retention_days prunes older rows on connect, without breaking cursor monotonicity', async () => {
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

  // BUG-27 (prune-timer unref): connect() with retention_days starts a prune setInterval. It must
  // be .unref()'d so a leaked-but-never-disconnect()ed plugin cannot by itself pin the event loop
  // (belt-and-suspenders behind buildBridge's disconnect-on-catch-up-failure). Drive connect() with
  // retention set, capture the timer setInterval actually returned, and assert it is NOT ref'd.
  it('BUG-27: the prune timer is unref()d so a leaked plugin cannot pin the event loop', async () => {
    const timers: Array<ReturnType<typeof setInterval>> = [];
    const realSetInterval = globalThis.setInterval;
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        const t = realSetInterval(fn, ms, ...args);
        timers.push(t);
        return t;
      }) as typeof setInterval);
    try {
      const p = new SqlitePlugin();
      open.push(p);
      await p.connect({ db_path: dbFile(), poll_interval_ms: 10, retention_days: 7 });
      // The prune interval is the only setInterval the plugin creates (the poll loop uses
      // setTimeout), and it must have been created and unref'd.
      expect(timers.length).toBeGreaterThanOrEqual(1);
      // hasRef() === false ⟺ .unref() was applied — the timer will not keep the process alive.
      expect(timers.every((t) => t.hasRef() === false)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('SqlitePlugin backendMsgId (BUG-40)', () => {
  it('is a bare decimal rowid with no Number() artifacts', async () => {
    const p = await plugin();
    const id1 = await p.post(T, me, 'a');
    const id2 = await p.post(T, me, 'b');
    expect(id1).toMatch(/^\d+$/);
    expect(id2).toMatch(/^\d+$/);

    const { messages } = await p.fetchRecent({ topic: T });
    expect(messages.map((m) => m.backendMsgId)).toEqual([id1, id2]);
  });
});

/**
 * `limit` reaches `fetchRecent` from a model whose context is untrusted inbound message content,
 * on a synchronous driver. A value it cannot serve must be refused or capped — never absorbed as
 * "no limit", which is how SQLite reads a negative LIMIT.
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

  for (const limit of [undefined, 1, MAX_PAGE, MAX_PAGE + 1, 1e9, Number.MAX_SAFE_INTEGER]) {
    it(`serves a page of ${String(limit)} capped at MAX_PAGE`, async () => {
      const p = await plugin();
      for (let i = 0; i < MAX_PAGE + 25; i++) await p.post(T, me, `m${i}`);
      const { messages } = await p.fetchRecent({ topic: T, limit });
      expect(messages).toHaveLength(Math.min(limit ?? 100, MAX_PAGE));
    });
  }

  it('a topic larger than MAX_PAGE is still fully drainable by paging', async () => {
    const p = await plugin();
    const rows = MAX_PAGE + 25;
    for (let i = 0; i < rows; i++) await p.post(T, me, `m${i}`);

    let cursor = (await p.fetchRecent({ topic: asTopic('never-posted') })).nextCursor;
    const seen: string[] = [];
    for (let page = 0; page < 10; page++) {
      const res = await p.fetchRecent({ topic: T, since: cursor, limit: 1e9 });
      expect(res.messages.length).toBeLessThanOrEqual(MAX_PAGE);
      if (res.messages.length === 0) break;
      seen.push(...res.messages.map((m) => m.content));
      cursor = res.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: rows }, (_u, i) => `m${i}`));
  });
});

describe('SqlitePlugin poll-loop diagnostics (BUG-39)', () => {
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
