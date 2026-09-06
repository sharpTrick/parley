import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asHandle,
  asTopic,
  catchUpTopic,
  MAX_BLOCK_MS,
  ReadStateStore,
  SeenSet,
} from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PAGE, SqlitePlugin } from '../src/index.js';

/**
 * Push on this backend is a SUBSET of the post-subscribe tail (DESIGN §6): `subscribe` starts at
 * the topic's tail as it stands when it is called, and everything below that is left to catch-up.
 * The subset it drops is the START-UP WINDOW — core runs `catchUpAll` to completion and arms
 * `startPushLoop` afterwards, so a row a peer commits in between is above the caller's persisted
 * cursor and below the tail the loop starts at.
 *
 * These grade both halves at once, because one without the other is a broken backend rather than a
 * lossy one: what push does NOT deliver, a `fetchRecent` resuming from the caller's own cursor DOES
 * — and the rows push does deliver are never replayed history.
 */

const me = asHandle('alice');
const T = asTopic('ctx');

let open: SqlitePlugin[] = [];
let dirs: string[] = [];

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'parley-gap-'));
  dirs.push(d);
  return d;
}

async function connected(path: string): Promise<SqlitePlugin> {
  const p = new SqlitePlugin();
  await p.connect({ db_path: path, poll_interval_ms: 10 });
  open.push(p);
  return p;
}

afterEach(async () => {
  await Promise.all(open.map((p) => p.disconnect()));
  open = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function fill(p: SqlitePlugin, contents: string[]): Promise<void> {
  for (const c of contents) await p.post(T, me, c);
}

const numbered = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_unused, i) => `${prefix}-${i}`);

const contents = (page: { messages: readonly { content: string }[] }): string[] =>
  page.messages.map((m) => m.content);

/**
 * Rows committed between the catch-up and the subscribe. Zero is the case where the two halves
 * coincide and nothing can distinguish a reconciled gap from no gap at all, so the table carries
 * sizes above it as well.
 */
const WINDOW_SIZES = [0, 1, 5];
const HISTORIES = [
  { name: 'a fresh topic', rows: 0, limit: 100 },
  { name: 'a topic with history', rows: 3, limit: 100 },
  { name: 'a topic whose history outruns the catch-up horizon', rows: 5, limit: 2 },
];

describe('the start-up window is dark on push and reconciled by the next catch-up', () => {
  for (const history of HISTORIES) {
    for (const size of WINDOW_SIZES) {
      it(`${history.name}, ${size} row(s) committed in the hand-off window`, async () => {
        const path = join(dir(), 'p.db');
        const reader = await connected(path);
        const peer = await connected(path);
        await fill(peer, numbered('history', history.rows));

        const readState = new ReadStateStore(join(dir(), 'state.json'));
        const seen = new SeenSet();
        await catchUpTopic({ plugin: reader, topic: T, limit: history.limit, readState, seen });
        const persisted = readState.get(T);
        expect(persisted).toBeDefined();

        const windowed = numbered('in-the-window', size);
        await fill(peer, windowed);

        const pushed: string[] = [];
        await reader.subscribe(T, (m) => pushed.push(m.content));
        await fill(peer, ['after-subscribe']);
        await vi.waitFor(() => expect(pushed).toContain('after-subscribe'), {
          timeout: 5000,
          interval: 10,
        });

        // The gap, named: push carries the tail it started at and nothing from the window below it.
        expect(pushed).toEqual(['after-subscribe']);

        // …and the window is not lost. A read resuming from the cursor the caller persisted returns
        // every row push skipped, in order, plus the ones it did deliver — which is what makes the
        // subset contract survivable and what core's SeenSet then dedupes against.
        const reconciled = await reader.fetchRecent({
          topic: T,
          since: persisted,
          limit: MAX_PAGE,
        });
        expect(contents(reconciled)).toEqual([...windowed, 'after-subscribe']);
      });
    }
  }

  /**
   * The counter-property. A live loop that started from the caller's cursor instead of the tail
   * would close the window — and replay, as `<channel>` events, history core's seen-set only partly
   * covers. Pinned separately from the rows above, because a loop that replayed everything would
   * still contain `after-subscribe`.
   */
  it('history behind the subscribe is never replayed as live push', async () => {
    const path = join(dir(), 'p.db');
    const reader = await connected(path);
    const peer = await connected(path);
    await fill(peer, numbered('history', 4));

    const pushed: string[] = [];
    await reader.subscribe(T, (m) => pushed.push(m.content));
    await fill(peer, ['after-subscribe']);

    await vi.waitFor(() => expect(pushed).toEqual(['after-subscribe']), {
      timeout: 5000,
      interval: 10,
    });
  });

  /**
   * The tail is sampled per topic, at the moment of the call: reading or subscribing one topic must
   * not move where another starts, or a quiet topic's loop resumes at a rowid a busy one minted and
   * delivers nothing for as long as it takes the quiet one to catch up.
   */
  it('the start point is per topic, not per store', async () => {
    const path = join(dir(), 'p.db');
    const reader = await connected(path);
    const peer = await connected(path);
    const other = asTopic('other');

    await fill(peer, numbered('busy', 20));
    const pushedOther: string[] = [];
    await reader.subscribe(other, (m) => pushedOther.push(m.content));
    await peer.post(other, me, 'other-after-subscribe');

    await vi.waitFor(() => expect(pushedOther).toEqual(['other-after-subscribe']), {
      timeout: 5000,
      interval: 10,
    });
  });

  /**
   * A rowid names a row in ONE store. A start point carried across a reconnect onto a different (or
   * reset) file sits above everything the new one will write for a long time — a live loop that
   * never delivers again, silently, which no amount of catch-up reconciliation would show up as.
   */
  it('a reconnect onto a different store delivers that store’s first row', async () => {
    const busy = join(dir(), 'busy.db');
    const fresh = join(dir(), 'fresh.db');

    const peerOnBusy = await connected(busy);
    await fill(peerOnBusy, numbered('history', 50));

    const reader = new SqlitePlugin();
    await reader.connect({ db_path: busy, poll_interval_ms: 10 });
    await reader.fetchRecent({ topic: T, limit: MAX_PAGE });
    await reader.disconnect();

    await reader.connect({ db_path: fresh, poll_interval_ms: 10 });
    open.push(reader);
    const peerOnFresh = await connected(fresh);
    const pushed: string[] = [];
    await reader.subscribe(T, (m) => pushed.push(m.content));
    await peerOnFresh.post(T, me, 'first-row-of-a-new-store');

    await vi.waitFor(() => expect(pushed).toEqual(['first-row-of-a-new-store']), {
      timeout: 5000,
      interval: 10,
    });
  });
});

/**
 * What makes the promise above WEAKER on this backend than "catch-up reconciles" sounds: the
 * reconciling read has to be one whose cursor the caller keeps. `catchUpTopic` persists through
 * `ReadStateStore`; the `parley_fetch_recent` MCP tool an agent calls by hand does not, so an agent
 * that reads the window and then reads again from its OLD cursor sees it twice rather than never —
 * which is why core's dedup, not the cursor, is what makes the overlap safe.
 */
describe('the reconciling read is only as good as the cursor the caller keeps', () => {
  it('re-reading from a stale cursor re-serves the window, and the seen-set absorbs it', async () => {
    const path = join(dir(), 'p.db');
    const reader = await connected(path);
    const peer = await connected(path);
    const readState = new ReadStateStore(join(dir(), 'state.json'));
    const seen = new SeenSet();

    await fill(peer, ['history']);
    await catchUpTopic({ plugin: reader, topic: T, limit: 100, readState, seen });
    const stale = readState.get(T);
    expect(stale).toBeDefined();

    await fill(peer, ['in-the-window']);
    const first = await reader.fetchRecent({ topic: T, since: stale, limit: MAX_PAGE });
    const again = await reader.fetchRecent({ topic: T, since: stale, limit: MAX_PAGE });
    expect(contents(first)).toEqual(['in-the-window']);
    expect(contents(again)).toEqual(['in-the-window']);

    for (const m of first.messages) expect(seen.firstSeen(T, m.backendMsgId)).toBe(true);
    for (const m of again.messages) expect(seen.firstSeen(T, m.backendMsgId)).toBe(false);
  });

  it('a block budget is refused rather than parked on, so a dark window is never waited out', async () => {
    const reader = await connected(join(dir(), 'p.db'));
    await expect(
      reader.fetchRecent({ topic: T, blockMs: Math.min(1_000, MAX_BLOCK_MS) }),
    ).rejects.toThrow(/block_ms/i);
  });
});
