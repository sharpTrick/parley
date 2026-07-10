import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asCursor, asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlitePlugin } from './index.js';

const T = asTopic('ctx');
const me = asHandle('alice');
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
    expect(messages[0]!.cursor).toBe('1');
    expect(messages[1]!.cursor).toBe('2');
    expect(messages[0]!.backendMsgId).toBe('1');
    expect(messages[0]!.mentions).toEqual(['bob']);
    expect(nextCursor).toBe('2');
  });

  it('fetchRecent({since}) is exclusive — only newer', async () => {
    const p = await plugin();
    await p.post(T, me, 'a');
    await p.post(T, me, 'b');
    const after = await p.fetchRecent({ topic: T, since: (await firstCursor(p)) });
    expect(after.messages.map((m: Message) => m.content)).toEqual(['b']);
    expect(after.nextCursor).toBe('2');

    const drained = await p.fetchRecent({ topic: T, since: after.nextCursor });
    expect(drained.messages).toEqual([]);
    expect(drained.nextCursor).toBe('2');
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

    // retention_days: 0 → cutoff is "now", strictly after the posts above → prunable immediately.
    await new Promise((r) => setTimeout(r, 5));
    const p = new SqlitePlugin();
    open.push(p);
    await p.connect({ db_path: path, poll_interval_ms: 10, retention_days: 0 });

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
});

// A fresh in-memory plugin — `:memory:` is a brand-new DB per connection, which is exactly the
// "DB reset" scenario BUG-23 is about (rowids restart at 1).
async function memPlugin(): Promise<SqlitePlugin> {
  const p = new SqlitePlugin();
  await p.connect({ db_path: ':memory:', poll_interval_ms: 10 });
  open.push(p);
  return p;
}

describe('SqlitePlugin cursor integrity (BUG-22/23/40)', () => {
  it('BUG-22: a malformed/foreign cursor throws instead of silently wedging catch-up', async () => {
    const p = await plugin();
    await p.post(T, me, 'a');
    await p.post(T, me, 'b');
    // Current (pre-fix) code returns { messages: [], nextCursor: 's123_456' } here — rows present,
    // no throw — which core then re-persists, wedging the topic forever. The fix rejects it loudly.
    await expect(p.fetchRecent({ topic: T, since: asCursor('s123_456') })).rejects.toThrow(
      /parley-sqlite: malformed cursor/,
    );
    await expect(p.fetchRecent({ topic: T, since: asCursor('m123abc') })).rejects.toThrow(
      /malformed cursor 'm123abc'/,
    );
  });

  it('BUG-22: an empty-string cursor throws instead of replaying all history', async () => {
    const p = await plugin();
    await p.post(T, me, 'a');
    await p.post(T, me, 'b');
    // Pre-fix: Number('') === 0 → `id > 0` → the whole topic replays. `^\d+$` rejects '' outright.
    await expect(p.fetchRecent({ topic: T, since: asCursor('') })).rejects.toThrow(
      /parley-sqlite: malformed cursor/,
    );
  });

  it('BUG-23: a stale cursor across a DB reset falls back instead of skipping new messages', async () => {
    // Instance A holds a high cursor from before the reset.
    const before = await memPlugin();
    for (const c of ['1', '2', '3', '4', '5']) await before.post(T, me, c);
    const staleCursor = (await before.fetchRecent({ topic: T })).nextCursor; // rowid 5
    expect(staleCursor).toBe('5');
    await before.disconnect();

    // The DB is recreated (fresh `:memory:`): teammates post while A was offline; ids restart at 1.
    const after = await memPlugin();
    for (const c of ['post-reset-1', 'post-reset-2', 'post-reset-3']) await after.post(T, me, c);

    // Pre-fix: `id > 5` against ids 1..3 → [] and A never sees the new messages. The fix detects
    // the stale cursor (5 > high-water 3) and falls back to the recent window, surfacing them.
    const caught = await after.fetchRecent({ topic: T, since: staleCursor });
    expect(caught.messages.map((m) => m.content)).toEqual([
      'post-reset-1',
      'post-reset-2',
      'post-reset-3',
    ]);
    expect(caught.messages).not.toEqual([]);
    // nextCursor is a fresh, well-formed cursor for this DB — the wedge self-heals.
    expect(caught.nextCursor).toBe('3');
  });

  it('BUG-40: minted cursor is a bare rowid that round-trips back through fetchRecent', async () => {
    const p = await plugin();
    const id1 = await p.post(T, me, 'a');
    const id2 = await p.post(T, me, 'b');
    // No Number() artifacts (NaN / precision): backendMsgId is a pure decimal rowid the seam
    // validator accepts.
    expect(id1).toMatch(/^\d+$/);
    expect(id2).toMatch(/^\d+$/);

    const { messages } = await p.fetchRecent({ topic: T });
    expect(messages[0]!.cursor).toMatch(/^\d+$/);
    expect(messages[0]!.backendMsgId).toBe(id1);

    // Feed a freshly-minted cursor straight back in as `since` — well-formed, non-throwing, exclusive.
    const round = await p.fetchRecent({ topic: T, since: messages[0]!.cursor });
    expect(round.messages.map((m) => m.content)).toEqual(['b']);
    expect(round.nextCursor).toBe(id2);
  });
});

async function firstCursor(p: SqlitePlugin) {
  const all = await p.fetchRecent({ topic: T });
  return all.messages[0]!.cursor;
}
