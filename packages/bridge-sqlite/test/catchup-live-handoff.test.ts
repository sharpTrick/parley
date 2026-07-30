import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asCursor,
  asHandle,
  asTopic,
  catchUpTopic,
  ReadStateStore,
  SeenSet,
} from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlitePlugin } from '../src/index.js';

/**
 * Core runs catch-up to completion and only arms `subscribe` later (`catchUpAll` in buildBridge,
 * `startPushLoop` in attach). Anything a peer commits in between belongs to NEITHER path unless the
 * live loop resumes from where catch-up handed off: it is below a start point sampled at arm time,
 * and above the read-state cursor core has already persisted. The counter-property is graded by the
 * same assertion — a loop that resumed from the start of the topic instead would replay history
 * core's seen-set only partly covers, as `<channel>` events.
 */

const me = asHandle('alice');
const T = asTopic('ctx');

let open: SqlitePlugin[] = [];
let dirs: string[] = [];

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'parley-handoff-'));
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

/**
 * `limit` below `rows` is the cold-start case where catch-up's horizon is SHORTER than the topic:
 * everything below it is history no reader is entitled to, so it grades the replay direction that
 * a fresh topic cannot.
 */
const HISTORIES = [
  { name: 'a fresh topic', rows: 0, limit: 100 },
  { name: 'a topic with history', rows: 3, limit: 100 },
  { name: 'a topic whose history outruns the catch-up horizon', rows: 5, limit: 2 },
];
const WINDOW_SIZES = [0, 1, 5];

describe('a message committed between catch-up and subscribe is still delivered live', () => {
  for (const history of HISTORIES) {
    for (const size of WINDOW_SIZES) {
      it(`${history.name}, ${size} message(s) committed in the hand-off window`, async () => {
        const path = join(dir(), 'p.db');
        const reader = await connected(path);
        const peer = await connected(path);
        await fill(peer, numbered('history', history.rows));

        const readState = new ReadStateStore(join(dir(), 'state.json'));
        const seen = new SeenSet();
        await catchUpTopic({ plugin: reader, topic: T, limit: history.limit, readState, seen });

        const windowed = numbered('in-the-window', size);
        await fill(peer, windowed);

        const pushed: string[] = [];
        await reader.subscribe(T, (m) => pushed.push(m.content));
        await fill(peer, ['after-subscribe']);

        await vi.waitFor(() => expect(pushed).toEqual([...windowed, 'after-subscribe']), {
          timeout: 5000,
          interval: 10,
        });
      });
    }
  }

  it('every reconnect cycle re-closes the window, not just the first', async () => {
    const path = join(dir(), 'p.db');
    const peer = await connected(path);
    const readState = new ReadStateStore(join(dir(), 'state.json'));
    const seen = new SeenSet();
    // ONE reader across the cycles: a hand-off point outliving the store it names would resume the
    // next generation's loop at a rowid from the previous one.
    const reader = new SqlitePlugin();

    for (const cycle of [0, 1, 2]) {
      await reader.connect({ db_path: path, poll_interval_ms: 10 });
      await catchUpTopic({ plugin: reader, topic: T, limit: 100, readState, seen });

      const windowed = [`cycle-${cycle}-in-the-window`];
      await fill(peer, windowed);

      const pushed: string[] = [];
      await reader.subscribe(T, (m) => pushed.push(m.content));
      await fill(peer, [`cycle-${cycle}-after-subscribe`]);

      await vi.waitFor(
        () => expect(pushed).toEqual([...windowed, `cycle-${cycle}-after-subscribe`]),
        { timeout: 5000, interval: 10 },
      );
      await reader.disconnect();
    }
  });

  /**
   * The hand-off point is a rowid, and rowids name rows in ONE store. Carried across a reconnect
   * onto a different (or reset) file, a high one from the old store sits above everything the new
   * one will write for a long time — a live loop that never delivers again, silently.
   */
  it('a reconnect onto a different store does not inherit the old one’s hand-off point', async () => {
    const busy = join(dir(), 'busy.db');
    const fresh = join(dir(), 'fresh.db');
    const readState = new ReadStateStore(join(dir(), 'state.json'));
    const seen = new SeenSet();

    const peerOnBusy = await connected(busy);
    await fill(peerOnBusy, numbered('history', 50));

    const reader = new SqlitePlugin();
    await reader.connect({ db_path: busy, poll_interval_ms: 10 });
    await catchUpTopic({ plugin: reader, topic: T, limit: 100, readState, seen });
    await reader.disconnect();

    await reader.connect({ db_path: fresh, poll_interval_ms: 10 });
    open.push(reader);
    const peerOnFresh = await connected(fresh);
    const pushed: string[] = [];
    await reader.subscribe(T, (m) => pushed.push(m.content));
    await fill(peerOnFresh, ['first-row-of-a-new-store']);

    await vi.waitFor(() => expect(pushed).toEqual(['first-row-of-a-new-store']), {
      timeout: 5000,
      interval: 10,
    });
  });

  /**
   * With no catch-up there is no hand-off point to resume from, and the topic's existing rows are
   * history the live path has never owned.
   */
  it('a subscribe with no catch-up before it still starts at the tail', async () => {
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
   * `parley_fetch_recent` takes a `since` of the caller's choosing, so a re-read of an older page
   * can land between catch-up and subscribe. The hand-off point it leaves behind must not be
   * BEHIND the one catch-up reached, or the live loop replays what catch-up already served.
   */
  it('a re-read of an older page does not pull the hand-off point backwards', async () => {
    const path = join(dir(), 'p.db');
    const reader = await connected(path);
    const peer = await connected(path);
    const readState = new ReadStateStore(join(dir(), 'state.json'));
    const seen = new SeenSet();

    await fill(peer, numbered('history', 4));
    await catchUpTopic({ plugin: reader, topic: T, limit: 100, readState, seen });
    const replayed = await reader.fetchRecent({ topic: T, since: asCursor('0'), limit: 2 });
    expect(replayed.messages.map((m) => m.content)).toEqual(['history-0', 'history-1']);

    const pushed: string[] = [];
    await reader.subscribe(T, (m) => pushed.push(m.content));
    await fill(peer, ['after-subscribe']);

    await vi.waitFor(() => expect(pushed).toEqual(['after-subscribe']), {
      timeout: 5000,
      interval: 10,
    });
  });

  /**
   * Catch-up on one topic must not move another topic's hand-off point: a shared watermark would
   * make an untouched topic's live loop resume from a rowid belonging to a busier one.
   */
  it('the hand-off point is per topic', async () => {
    const path = join(dir(), 'p.db');
    const reader = await connected(path);
    const peer = await connected(path);
    const other = asTopic('other');
    const readState = new ReadStateStore(join(dir(), 'state.json'));
    const seen = new SeenSet();

    await fill(peer, ['ctx-history']);
    for (const c of ['other-history-0', 'other-history-1']) await peer.post(other, me, c);
    await catchUpTopic({ plugin: reader, topic: T, limit: 100, readState, seen });

    await peer.post(other, me, 'other-in-the-window');
    const pushedOther: string[] = [];
    await reader.subscribe(other, (m) => pushedOther.push(m.content));
    await peer.post(other, me, 'other-after-subscribe');

    await vi.waitFor(() => expect(pushedOther).toEqual(['other-after-subscribe']), {
      timeout: 5000,
      interval: 10,
    });
  });
});
