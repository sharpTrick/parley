import {
  asCursor,
  asHandle,
  asTopic,
  catchUpTopic,
  type Cursor,
  fetchRecentBlocking,
  ReadStateStore,
  SeenSet,
} from '@sharptrick/parley-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatrixPlugin } from '../src/index.js';
import { connectFake, FakeSynapse } from './fake-synapse.js';

/**
 * Matrix catch-up & sync correctness.
 *
 * These drive the ACTUAL plugin code (fetchRecent / subscribe / backfill) against the in-memory
 * fake Synapse in `./fake-synapse.ts`. No live homeserver: the conformance suite
 * (`conformance.test.ts`) covers the live drive and is `describe.skip`'d when no Synapse answers.
 */

let fake: FakeSynapse;
const install = (): FakeSynapse => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
  return fake;
};

const connect = (shared: boolean): Promise<MatrixPlugin> => connectFake({ shared });

const rsPath = () => join(mkdtempSync(join(tmpdir(), 'parley-mx-')), 'read-state.json');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchRecent since-path drains a foreign block and always advances the cursor', () => {
  it('shared_room: a later on-topic message after a full page of foreign-topic events is returned', async () => {
    install();
    const p = await connect(true);
    const A = asTopic('topic-A');
    const B = asTopic('topic-B');
    const writer = asHandle('w');

    const idA0 = await p.post(A, writer, 'a0'); // cursor X for topic A
    for (let i = 0; i < 5; i++) await p.post(B, writer, `b${i}`); // a full page (limit=5) of foreign topic
    const idA1 = await p.post(A, writer, 'a1'); // the message that MUST stay reachable

    const res = await p.fetchRecent({ topic: A, since: asCursor(String(idA0)), limit: 5 });

    // The trailing A message is returned rather than masked forever behind the foreign page.
    expect(res.messages.map((m) => m.content)).toEqual(['a1']);
    // nextCursor strictly advanced past X (it is a1's cursor, never the input `since`).
    expect(String(res.nextCursor)).not.toBe(String(idA0));
    expect(String(res.nextCursor)).toBe(String(idA1));
    await p.disconnect();
  });

  it('any-room-mode: a full page of non-m.room.message events (reactions) does not wedge the cursor', async () => {
    const f = install();
    const p = await connect(false); // per-topic room mode
    const T = asTopic('reacty');
    const writer = asHandle('w');

    const idT0 = await p.post(T, writer, 't0');
    for (let i = 0; i < 5; i++) f.addRaw('m.reaction'); // a full page of non-message churn
    const idT1 = await p.post(T, writer, 't1');

    const res = await p.fetchRecent({ topic: T, since: asCursor(String(idT0)), limit: 5 });
    expect(res.messages.map((m) => m.content)).toEqual(['t1']);
    expect(String(res.nextCursor)).toBe(String(idT1));
    await p.disconnect();
  });

  it('catchUpTopic over the same shared room counts the trailing A message and advances read-state past X', async () => {
    install();
    const p = await connect(true);
    const A = asTopic('cu-A');
    const B = asTopic('cu-B');
    const writer = asHandle('w');

    const idA0 = await p.post(A, writer, 'a0');
    for (let i = 0; i < 5; i++) await p.post(B, writer, `b${i}`);
    const idA1 = await p.post(A, writer, 'a1');

    const readState = new ReadStateStore(rsPath());
    const seen = new SeenSet();
    readState.set(A, asCursor(String(idA0))); // persisted cursor stuck at X before the fix

    const total = await catchUpTopic({ plugin: p, topic: A, limit: 5, readState, seen });

    expect(total).toBe(1); // drains the trailing a1 rather than breaking early at 0
    expect(String(readState.get(A))).toBe(String(idA1)); // read-state crossed the foreign block
    await p.disconnect();
  });
});

/**
 * CLASS: a cursor must cross a block of traffic it cannot return, and must not move for traffic it
 * simply has not reached — and a BLOCKING call must report the same position a non-blocking one
 * would. `/messages` bounds a page BEFORE filtering, so a page-sized block of another topic's events
 * would wedge a cursor pinned at `since` forever; but advancing on a SHORT (end-of-timeline) page
 * means any traffic on any other topic in a shared room silently moves this topic's cursor, breaking
 * the seam's "since at the tail returns empty and a STABLE cursor" contract for every reader of that
 * room. A `blockMs` that discarded the advance would make the answer depend on the wait, not the
 * timeline.
 *
 * The depth is SWEPT across the page boundary rather than sampled, because the decision is made at
 * `count === limit` and the `since` event itself can occupy a page slot — hand-picked depths straddle
 * the cell where a short page is misjudged as full. Two NECESSARY conditions bound the sweep from
 * both sides, neither derived from how the paging is implemented, so a re-implementation cannot
 * mirror them into a pass:
 *   fewer than `limit` events exist after the cursor  → no full page can exist  → MUST stay stable
 *   at least `2 * limit` do (a full page even if the cursor event steals a slot) → MUST advance
 * Between those the plugin may do either, and only replayability is graded.
 */
const LIMITS = [1, 2, 5];
const sweep = (limit: number): number[] => Array.from({ length: 2 * limit + 1 }, (_, i) => i);
const cursorMustMove = (count: number, limit: number): boolean | undefined =>
  count < limit ? false : count >= 2 * limit ? true : undefined;

/** 0 = the plain catch-up; >0 drives the native long-poll, which must agree with it. */
const BLOCK_MODES = [0, 150];

describe('a foreign block moves this topic cursor only when it fills a page', () => {
  for (const limit of LIMITS) {
    for (const count of sweep(limit)) {
      const must = cursorMustMove(count, limit);
      for (const blockMs of BLOCK_MODES) {
        it(`limit ${limit} / ${count} foreign event(s) after the cursor / blockMs ${blockMs}: moves it = ${must ?? 'either'}`, async () => {
          install();
          const p = await connect(true);
          const A = asTopic('topic-A');
          const B = asTopic('topic-B');
          const writer = asHandle('w');

          const idA0 = await p.post(A, writer, 'a0');
          for (let i = 0; i < count; i++) await p.post(B, writer, `b${i}`);

          const at = await p.fetchRecent({ topic: A, since: asCursor(String(idA0)), limit, blockMs });
          expect(at.messages).toEqual([]);
          const moved = String(at.nextCursor) !== String(idA0);
          if (must !== undefined) expect(moved).toBe(must);

          // Whatever it reported, the cursor is replayable: the next on-topic message is returned from
          // it exactly once, and the read is idempotent until then.
          const again = await p.fetchRecent({ topic: A, since: at.nextCursor, limit });
          expect(again.messages).toEqual([]);
          const idA1 = await p.post(A, writer, 'a1');
          const next = await p.fetchRecent({ topic: A, since: at.nextCursor, limit });

          expect(next.messages.map((m) => m.content)).toEqual(['a1']);
          expect(String(next.nextCursor)).toBe(String(idA1));
          await p.disconnect();
        });
      }
    }
  }

  /**
   * WHEN the foreign traffic lands is an axis of the blocking answer, not a detail of the fixture.
   * A block staged BEFORE the call is already crossed by the pre-block query whose cursor seeds the
   * wait, so every such row grades the seed and none of them grades the carry that advances it
   * across each empty re-query — a distinction worth one page of foreign traffic per long-poll
   * window, compounding until the topic sits past the forward-page bound and wedges. Each row
   * proves its traffic landed, so one that armed nothing fails instead of re-grading the seed.
   */
  const BLOCK_MS = 900;
  /** More than one `limit`-sized forward page, so a cursor that fails to carry cannot cross it. */
  const FOREIGN_DEPTH = 9;
  const BLOCK_LIMIT = 3;

  const FOREIGN_BLOCK_LANDS: Record<
    string,
    (f: FakeSynapse, land: () => void) => { fired: () => boolean; cancel: () => void }
  > = {
    'before the call': (_f, land) => {
      land();
      return { fired: () => true, cancel: () => undefined };
    },
    'inside the dedicated /sync positioning window': (f, land) => {
      let fired = false;
      f.stallPositioningMs = 60;
      f.stallPositioning = (ordinal) => ordinal === 1;
      f.duringPositioningStall = (ordinal) => {
        if (ordinal !== 1 || fired) return;
        fired = true;
        land();
      };
      return { fired: () => fired, cancel: () => undefined };
    },
    'mid-block, after the first empty re-query': (_f, land) => {
      let fired = false;
      const timer = setTimeout(() => {
        fired = true;
        land();
      }, 120);
      return { fired: () => fired, cancel: () => clearTimeout(timer) };
    },
  };

  for (const [whenName, place] of Object.entries(FOREIGN_BLOCK_LANDS)) {
    it(`a foreign block landing ${whenName}: the blocking cursor is the one a plain read reports`, async () => {
      const f = install();
      const p = await connect(true);
      const A = asTopic('topic-A');
      const B = asTopic('topic-B');
      const writer = asHandle('w');

      const idA0 = await p.post(A, writer, 'a0');
      const since = asCursor(String(idA0));
      const armed = place(f, () => {
        for (let i = 0; i < FOREIGN_DEPTH; i++) f.addMessage(String(B), `b${i}`);
      });

      const blocked = await p.fetchRecent({ topic: A, since, limit: BLOCK_LIMIT, blockMs: BLOCK_MS });
      armed.cancel();
      const plain = await p.fetchRecent({ topic: A, since, limit: BLOCK_LIMIT });

      expect(armed.fired(), 'no foreign traffic landed, so this row grades the seed cursor').toBe(
        true,
      );
      expect(blocked.messages).toEqual([]);
      expect(String(blocked.nextCursor)).toBe(String(plain.nextCursor));
      expect(String(blocked.nextCursor)).not.toBe(String(idA0));
      await p.disconnect();
    }, 30_000);
  }

  /**
   * The bound on forward pagination (MAX_FORWARD_PAGES * limit) is only survivable because each
   * drain advances the cursor. Driven through core's own `fetchRecentBlocking`, which feeds
   * `nextCursor` back as the next `since` — the exact loop a wedged cursor makes infinite.
   */
  it('a foreign block deeper than one drain is crossed by the blocking driver, not wedged', async () => {
    install();
    const p = await connect(true);
    const A = asTopic('deep-A');
    const B = asTopic('deep-B');
    const writer = asHandle('w');

    const idA0 = await p.post(A, writer, 'a0');
    for (let i = 0; i < 300; i++) await p.post(B, writer, `b${i}`);
    const idA1 = await p.post(A, writer, 'a1');

    let since = asCursor(String(idA0));
    const drained: string[] = [];
    // A budget comfortably longer than one drain, so the plugin's native long-poll really is the
    // thing reporting the cursor — a budget the first drain already spends returns before it.
    for (let call = 0; call < 4 && drained.length === 0; call++) {
      const page = await fetchRecentBlocking(
        p,
        { topic: A, since, limit: 5 },
        { blockMs: 2000, pollIntervalMs: 10 },
      );
      drained.push(...page.messages.map((m) => m.content));
      since = page.nextCursor;
    }

    expect(drained).toEqual(['a1']);
    expect(String(since)).toBe(String(idA1));
    await p.disconnect();
  }, 30_000);
});

/**
 * Two CLASSES over one table.
 *
 *  1. A de-duplication guard whose triggering condition the fake cannot construct. Recovering a
 *     `limited` burst pages backwards from `prev_batch`, and whether that token re-includes the batch
 *     it arrived with is not pinned by the spec — Synapse's is exclusive, so the plugin's `skip` set
 *     never fires against it and could be deleted with the suite green. Sweeping the overlap makes
 *     the boundary itself an axis.
 *  2. A live-path recovery boundary established at a DIFFERENT INSTANT than the subscription
 *     position. The backward recovery stops at "the last event already delivered", and that boundary
 *     has to be the subscription position exactly: read one round-trip LATER and everything that
 *     landed in between is graded as already-delivered and silently dropped; read EARLIER (or not at
 *     all) and the recovery pages back past the position and replays PRE-subscription history as
 *     live events. `WHEN_EVENTS_LAND` puts a burst on each side of that instant, and every row is
 *     seeded with pre-subscription history so both directions are graded at once.
 *
 * Every cell must deliver EXACTLY the post-position events, once, ascending.
 */
const PREV_BATCH_OVERLAPS = [0, 1, 2];
const SYNC_CAPS = [1, 2, 3];
const BURST = 5;
/** On-topic history that exists BEFORE subscribe — never live, in either room mode. */
const PRE_HISTORY = ['h0', 'h1', 'h2', 'h3'];
const WINDOW = ['w0', 'w1', 'w2'];

/**
 * Where the first tranche of live events lands. `arm` returns the proof it fired, so a row that
 * armed nothing fails instead of quietly grading the other cell.
 */
const WHEN_EVENTS_LAND: Record<
  string,
  { landed: string[]; arm: (f: FakeSynapse, land: (c: string) => void) => () => boolean }
> = {
  'after subscribe() returns': { landed: [], arm: () => () => true },
  'between the subscription position and subscribe() returning': {
    landed: WINDOW,
    arm: (f, land) => {
      let fired = false;
      f.afterPositioningSync = (ordinal) => {
        if (ordinal !== 1 || fired) return;
        fired = true;
        for (const c of WINDOW) land(c);
      };
      return () => fired;
    },
  },
};

describe('subscribe recovers a burst larger than the per-sync cap via prev_batch', () => {
  for (const [whenName, when] of Object.entries(WHEN_EVENTS_LAND)) {
    for (const overlap of PREV_BATCH_OVERLAPS) {
      for (const syncCap of SYNC_CAPS) {
        it(`prev_batch overlaps by ${overlap} / per-sync cap ${syncCap} / events land ${whenName}: exactly the post-position events, once`, async () => {
          const f = install();
          f.syncCap = syncCap; // truncates any incremental sync → forces limited:true
          f.prevBatchOverlap = overlap;
          const p = await connect(false); // per-topic room
          const T = asTopic('burst');
          const writer = asHandle('w');
          for (const c of PRE_HISTORY) await p.post(T, writer, c);

          const got: string[] = [];
          const fired = when.arm(f, (c) => void f.addMessage(String(T), c));
          await p.subscribe(T, (m) => got.push(m.content));

          // While the loop is between polls, the rest of the burst lands at once (> syncCap →
          // truncated), so recovery through `prev_batch` is the only way any of it is delivered.
          const burst = Array.from({ length: BURST }, (_, i) => `m${i}`);
          for (const c of burst) f.addMessage(String(T), c);
          const expected = [...when.landed, ...burst];

          await vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(expected.length), {
            timeout: 4000,
            interval: 10,
          });
          // Keep this settle, so that a DUPLICATE arriving one poll later fails the row instead of
          // landing after the assertion read it.
          await new Promise((r) => setTimeout(r, 150));

          expect(fired()).toBe(true);
          expect(got).toEqual(expected); // ascending, complete, in order, no duplicate, no history
          expect(f.limitedEmitted).toBeGreaterThan(0); // the truncation/backfill path actually ran
          await p.disconnect();
        });
      }
    }
  }

  /**
   * The same boundary in `shared_room` mode, where the pre-subscription history the recovery must
   * not page into is mostly ANOTHER topic's — the case in which a boundary derived from this topic's
   * own messages does not exist at all.
   */
  for (const [whenName, when] of Object.entries(WHEN_EVENTS_LAND)) {
    it(`shared_room / events land ${whenName}: foreign pre-history is never replayed as live`, async () => {
      const f = install();
      f.syncCap = 2;
      f.prevBatchOverlap = 1;
      const p = await connect(true);
      const T = asTopic('burst');
      const writer = asHandle('w');
      for (const c of PRE_HISTORY) await p.post(asTopic('someone-else'), writer, c);
      await p.post(T, writer, 'mine-before-subscribe');

      const got: string[] = [];
      const fired = when.arm(f, (c) => void f.addMessage(String(T), c));
      await p.subscribe(T, (m) => got.push(m.content));

      const burst = Array.from({ length: BURST }, (_, i) => `m${i}`);
      for (const c of burst) f.addMessage(String(T), c);
      const expected = [...when.landed, ...burst];

      await vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(expected.length), {
        timeout: 4000,
        interval: 10,
      });
      await new Promise((r) => setTimeout(r, 150));

      expect(fired()).toBe(true);
      expect(got).toEqual(expected);
      expect(f.limitedEmitted).toBeGreaterThan(0);
      await p.disconnect();
    });
  }
});

describe('fetchRecent honors blockMs natively via a bounded /sync long-poll', () => {
  it('wakes promptly when a message lands mid-wait, returning it via the canonical catch-up', async () => {
    install();
    const p = await connect(false); // per-topic room; no subscribe loop → dedicated bounded /sync
    const T = asTopic('block-wake');
    const writer = asHandle('w');

    await p.post(T, writer, 'old');
    const tail = (await p.fetchRecent({ topic: T })).nextCursor;

    const pending = p.fetchRecent({ topic: T, since: tail, blockMs: 2000 });
    // A message lands ~60ms into the wait (after the first bounded /sync has parked).
    setTimeout(() => void p.post(T, writer, 'fresh'), 60);

    const woke = await pending;
    expect(woke.messages.map((m) => m.content)).toEqual(['fresh']);
    expect(String(woke.nextCursor)).not.toBe(String(tail)); // cursor advanced past the floor
    await p.disconnect();
  });

  it('returns an empty page with a stable, replayable cursor at the blockMs timeout', async () => {
    install();
    const p = await connect(false);
    const T = asTopic('block-timeout');
    const writer = asHandle('w');

    await p.post(T, writer, 'only');
    const tail = (await p.fetchRecent({ topic: T })).nextCursor;

    const started = Date.now();
    const timedOut = await p.fetchRecent({ topic: T, since: tail, blockMs: 250 });
    expect(timedOut.messages).toEqual([]);
    expect(String(timedOut.nextCursor)).toBe(String(tail)); // stable — replaying it yields [] again
    expect(Date.now() - started).toBeGreaterThanOrEqual(150); // actually blocked, not instant
    await p.disconnect();
  });

  it('disconnect() aborts an in-flight blocking fetch promptly (no leak, no hang)', async () => {
    install();
    const p = await connect(false);
    const T = asTopic('block-disconnect');
    const writer = asHandle('w');

    await p.post(T, writer, 'seed');
    const tail = (await p.fetchRecent({ topic: T })).nextCursor;

    const started = Date.now();
    const pending = p.fetchRecent({ topic: T, since: tail, blockMs: 5000 });
    setTimeout(() => void p.disconnect(), 50);

    const res = await pending; // must resolve well before the 5s budget
    expect(res.messages).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

/**
 * CLASS: two cursor forms with asymmetric error handling. `buildBridge` AWAITS `catchUpAll`, so any
 * cursor a read-state file can hold and the homeserver can refuse must degrade to the documented
 * recent window — a throw here does not fail one read, it fails every subsequent restart until the
 * file is hand-edited. The forms are every shape a `since` argument can carry: this plugin's own two
 * (`event_id`, `@parley-stream:`), the pre-prefix sentinel, and a value from another backend. The
 * sentinel is the one form `ReadStateStore` refuses outright, so it grades the cold-start path
 * instead. The last row is the negative control: a cursor the homeserver DOES resolve must not
 * degrade.
 */
const STALE_CURSORS: Record<
  string,
  {
    since: (p: MatrixPlugin, ids: string[]) => Promise<Cursor>;
    /** Set when the cursor can only be minted before the topic has a room. */
    mintFirst?: true;
    /** Set when `ReadStateStore` refuses the form outright, so catch-up runs as a cold start. */
    refusedByReadState?: true;
    expected: string[];
  }
> = {
  'an event id purged from the room (404 on /context)': {
    since: async () => asCursor('$purged:fake'),
    expected: ['a', 'b', 'c'],
  },
  'a value minted by another backend entirely': {
    since: async () => asCursor('42'),
    expected: ['a', 'b', 'c'],
  },
  'the pre-prefix empty sentinel': {
    since: async () => asCursor(''),
    refusedByReadState: true,
    expected: ['a', 'b', 'c'],
  },
  'a @parley-stream: token the homeserver rejects (400 on /messages)': {
    since: async () => asCursor('@parley-stream:garbage'),
    expected: ['a', 'b', 'c'],
  },
  'a @parley-stream: token minted before the room existed': {
    since: async (p) => (await p.fetchRecent({ topic: asTopic('stale'), limit: 100 })).nextCursor,
    mintFirst: true,
    expected: ['a', 'b', 'c'],
  },
  'an event id the homeserver still resolves': {
    since: async (_p, ids) => asCursor(ids[0]!),
    expected: ['b', 'c'],
  },
};

describe('every cursor form a read-state file can hold comes up rather than throwing', () => {
  for (const [name, row] of Object.entries(STALE_CURSORS)) {
    it(`${name}: fetchRecent resolves and catchUpTopic starts up`, async () => {
      install();
      const p = await connect(false);
      const T = asTopic('stale');
      const writer = asHandle('w');
      const early = row.mintFirst === true ? await row.since(p, []) : undefined;
      const ids: string[] = [];
      for (const c of ['a', 'b', 'c']) ids.push(String(await p.post(T, writer, c)));
      const since = early ?? (await row.since(p, ids));

      const res = await p.fetchRecent({ topic: T, since, limit: 100 });
      expect(res.messages.map((m) => m.content)).toEqual(row.expected);
      expect(String(res.nextCursor)).toBe(String(res.messages.at(-1)!.backendMsgId));
      // The same cursor through the startup path, which is where a throw is unrecoverable.
      const readState = new ReadStateStore(rsPath());
      if (row.refusedByReadState === true) {
        expect(() => readState.set(T, since)).toThrow(TypeError);
        expect(readState.get(T)).toBeUndefined();
      } else {
        readState.set(T, since);
        expect(readState.get(T)).toBe(since);
      }
      const total = await catchUpTopic({
        plugin: p,
        topic: T,
        limit: 100,
        readState,
        seen: new SeenSet(),
      });

      expect(total).toBe(row.expected.length);
      await p.disconnect();
    });
  }
});
