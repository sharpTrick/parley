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

/** Live loops run at once, and rows written under each after they are all open. */
const SUBSCRIPTIONS = 3;
const LIVE_ROUNDS = 4;
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
        // On-start catch-up warms the dedup set and leaves the caller's position alone —
        // `parley_fetch_recent` is what advances it, out of the page it hands the agent. Take the
        // same cursor that tool would persist for a session starting cold on this topic.
        expect(readState.get(T)).toBeUndefined();
        const persisted = (await reader.fetchRecent({ topic: T, limit: history.limit })).nextCursor;
        readState.set(T, persisted);
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
   * The start point belongs to the SUBSCRIPTION, not to the store and not to the topic. Its
   * predecessor asserted "per topic, not per store" — which nothing can observe, because a rowid
   * only rises: a start point taken from the store's tail still sits below every row the topic will
   * later receive, so the whole package stayed green with the store-global spelling in place. What
   * IS observable is what a start point is FOR. Several live loops run at once in any real
   * deployment, and one that shares its position with another hands each subscriber half the
   * stream — a live path that looks alive from every angle and drops rows an agent is waiting on.
   */
  it.each([
    ['the same topic', true],
    ['distinct topics', false],
  ])(
    'concurrent subscriptions over %s each receive the whole post-subscribe sequence',
    async (_label, shared) => {
      const path = join(dir(), 'p.db');
      const reader = await connected(path);
      const peer = await connected(path);
      const topics = Array.from({ length: SUBSCRIPTIONS }, (_unused, i) =>
        shared ? T : asTopic(`t${i}`),
      );
      // History under every subscription, so a loop that started at the store's tail — or replayed
      // what was already there — is visible as well as one that shares a position.
      for (const [i, t] of topics.entries()) {
        for (const c of numbered(`history-${i}`, 5)) await peer.post(t, me, c);
      }

      const got: string[][] = topics.map(() => []);
      for (const [i, t] of topics.entries()) {
        await reader.subscribe(t, (m) => got[i]!.push(m.content));
      }

      // Interleaved across the subscriptions, so a position shared between two of them splits the
      // stream rather than merely reordering one.
      const owed: string[][] = topics.map(() => []);
      for (let round = 0; round < LIVE_ROUNDS; round++) {
        for (const [i, t] of topics.entries()) {
          const content = `live-${i}-${round}`;
          await peer.post(t, me, content);
          if (shared) for (const each of owed) each.push(content);
          else owed[i]!.push(content);
        }
      }

      await vi.waitFor(() => expect(got).toEqual(owed), { timeout: 5000, interval: 10 });
    },
  );

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
 * The overlap the reconciliation is allowed to have. `catchUpTopic` and `parley_fetch_recent` both
 * persist through `ReadStateStore`, so an agent that reads and then reads again sees the window
 * once — but a caller is free to pass a cursor of its own, and one BEHIND the position it holds
 * re-serves rows it already had. That is safe because core's dedup absorbs the repeat, and this is
 * where that is executed rather than asserted in prose.
 */
describe('a read from a stale cursor of the caller’s own re-serves, and dedup absorbs it', () => {
  it('re-reading from a stale cursor re-serves the window, and the seen-set absorbs it', async () => {
    const path = join(dir(), 'p.db');
    const reader = await connected(path);
    const peer = await connected(path);
    const readState = new ReadStateStore(join(dir(), 'state.json'));
    const seen = new SeenSet();

    await fill(peer, ['history']);
    await catchUpTopic({ plugin: reader, topic: T, limit: 100, readState, seen });
    const stale = (await reader.fetchRecent({ topic: T, limit: 100 })).nextCursor;
    readState.set(T, stale);
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
