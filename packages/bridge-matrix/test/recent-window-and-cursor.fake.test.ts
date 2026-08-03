import {
  asCursor,
  asHandle,
  asTopic,
  type BackendPlugin,
  type Cursor,
  type FetchRecentResult,
  type Topic,
} from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixPlugin } from '../src/index.js';
import { SHAPES } from './cursor-shapes.js';
import { aliasForTopic, connectFake, fakeConfig, FakeSynapse } from './fake-synapse.js';

/**
 * Two seam CLASSES, table-driven so a variant nobody tried is still covered:
 *
 *  1. A page limit is a TRANSPORT bound, never a RESULT bound — `fetchRecent` must return the
 *     topic's messages however deep the on-the-wire noise in front of them is.
 *  2. A cursor this backend mints must, when replayed, return exactly the messages that landed
 *     after it — never a truncated most-recent window.
 */

const LIMIT = 5;
const WRITER = asHandle('writer');

let fake: FakeSynapse;
beforeEach(() => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Kinds of timeline traffic that occupy raw page slots without belonging to the read topic — one
 * row per PREDICATE the plugin actually applies (the topic tag; the event type). Which non-message
 * type it is never reaches a branch, so `m.reaction` and `m.room.member` are one row, not two.
 */
const NOISE = {
  'foreign-topic message': (f: FakeSynapse, i: number) => f.addMessage('someone-elses-topic', `n${i}`),
  'non-message event': (f: FakeSynapse, i: number) => f.addRaw(i % 2 === 0 ? 'm.reaction' : 'm.room.member'),
} as const;

const NOISE_DEPTHS = [LIMIT - 1, LIMIT, LIMIT * 3];

/** Replay `cursor` to exhaustion exactly as core's catch-up driver does, collecting contents. */
async function drainFrom(
  plugin: BackendPlugin,
  topic: Topic,
  cursor: Cursor,
  limit: number,
): Promise<{ contents: string[]; finalCursor: Cursor }> {
  let since = cursor;
  const contents: string[] = [];
  for (;;) {
    const page = await plugin.fetchRecent({ topic, since, limit });
    contents.push(...page.messages.map((m) => m.content));
    const stop = page.messages.length < limit || page.nextCursor === since;
    since = page.nextCursor;
    if (stop) break;
  }
  return { contents, finalCursor: since };
}

describe('recent window: a raw page cap must not hide a topic behind noise', () => {
  for (const shared of [true, false]) {
    for (const [noiseName, addNoise] of Object.entries(NOISE)) {
      // Foreign-topic traffic only exists when topics share a room; a per-topic room has none.
      if (!shared && noiseName === 'foreign-topic message') continue;
      for (const depth of NOISE_DEPTHS) {
        const label = `${shared ? 'shared_room' : 'per-topic'} / ${noiseName} x${depth}`;

        it(`${label}: the since-less window returns every message of the topic`, async () => {
          const p = await connectFake({ shared });
          const t = asTopic('payments');
          for (const c of ['x1', 'x2', 'x3']) await p.post(t, WRITER, c);
          for (let i = 0; i < depth; i++) addNoise(fake, i);

          const res = await p.fetchRecent({ topic: t, limit: LIMIT });

          expect(res.messages.map((m) => m.content)).toEqual(['x1', 'x2', 'x3']);
          expect(String(res.nextCursor)).toBe(String(res.messages.at(-1)!.cursor));
          await p.disconnect();
        });

        it(`${label}: the expired-cursor fallback returns every message of the topic`, async () => {
          const p = await connectFake({ shared });
          const t = asTopic('payments');
          for (const c of ['x1', 'x2', 'x3']) await p.post(t, WRITER, c);
          for (let i = 0; i < depth; i++) addNoise(fake, i);

          const res = await p.fetchRecent({
            topic: t,
            since: asCursor('$purged-by-retention:fake'),
            limit: LIMIT,
          });

          expect(res.messages.map((m) => m.content)).toEqual(['x1', 'x2', 'x3']);
          await p.disconnect();
        });
      }
    }
  }
});

/**
 * CLASS: a seam bound this package's own fixtures cannot exercise, because their traffic is
 * homogeneous. `limit` is a HARD cap on the returned page (`packages/conformance` asserts
 * `messages.length <= limit`, and pins the since-less window as the NEWEST `limit`), but both paging
 * loops stop on `collected.length < limit` while each page may add a full `limit` belonging messages
 * — so a page that lands PART-full overshoots, and only the final `slice(0, limit)` brings it back.
 * Deleting either cap left every test in this package green, the live conformance run included: the
 * tables above put their noise BEHIND or IN FRONT of the belonging traffic, never BETWEEN two runs of
 * it, which is the only arrangement that makes a page land part-full.
 *
 * `k` is how many belonging messages the FIRST page finds (1 ≤ k < limit — at k = 0 the loop just
 * pages again, at k = limit it stops), so the second page overshoots to `k + limit`.
 */
const CAP_LIMITS = [2, 3, 5];
const FOREIGN = 'someone-elses-topic';

describe('limit is a hard cap even when a page lands part-full', () => {
  for (const limit of CAP_LIMITS) {
    for (let k = 1; k < limit; k++) {
      const label = `limit ${limit} / first page holds ${k} of them`;

      it(`${label}: the since-less window returns exactly the newest ${limit}`, async () => {
        const p = await connectFake({ shared: true });
        const t = asTopic('capped');
        const belonging: string[] = [];
        for (let i = 0; i < limit; i++) {
          belonging.push(`old-${i}`);
          await p.post(t, WRITER, `old-${i}`);
        }
        for (let i = 0; i < limit - k; i++) fake.addMessage(FOREIGN, `f${i}`);
        for (let i = 0; i < k; i++) {
          belonging.push(`new-${i}`);
          await p.post(t, WRITER, `new-${i}`);
        }

        const res = await p.fetchRecent({ topic: t, limit });

        expect(res.messages).toHaveLength(limit);
        expect(res.messages.map((m) => m.content)).toEqual(belonging.slice(-limit));
        await p.disconnect();
      });

      it(`${label}: the exclusive-since page caps, and the rest is still reachable`, async () => {
        const p = await connectFake({ shared: true });
        const t = asTopic('capped');
        const seed = await p.post(t, WRITER, 'seed');
        const after: string[] = [];
        for (let i = 0; i < k; i++) {
          after.push(`a-${i}`);
          await p.post(t, WRITER, `a-${i}`);
        }
        for (let i = 0; i < limit - 1 - k; i++) fake.addMessage(FOREIGN, `f${i}`);
        for (let i = 0; i < limit; i++) {
          after.push(`b-${i}`);
          await p.post(t, WRITER, `b-${i}`);
        }

        const page = await p.fetchRecent({ topic: t, since: asCursor(String(seed)), limit });

        expect(page.messages).toHaveLength(limit);
        expect(page.messages.map((m) => m.content)).toEqual(after.slice(0, limit));
        // Nothing the cap held back is lost: replaying the cursor drains the remainder in order.
        const { contents } = await drainFrom(p, t, page.nextCursor, limit);
        expect(contents).toEqual(after.slice(limit));
        await p.disconnect();
      });
    }
  }
});

/**
 * How the cursor under test was minted. `lossless` marks the ones this plugin MINTED itself — those
 * must replay to everything after them. A cursor it never minted (purged / foreign) is allowed to
 * degrade to the documented recent window, but even then only ever to a SUFFIX: no mid-stream gap.
 *
 * `shape` names the cursor FORM the origin produces, out of {@link SHAPES} — the single table both
 * these tests and the doc-parity check in `shipped-artifacts.test.ts` are driven from.
 */
const CURSOR_ORIGINS: Record<
  string,
  {
    lossless: boolean;
    shape: keyof typeof SHAPES;
    mint: (p: MatrixPlugin, t: Topic) => Promise<Cursor>;
  }
> = {
  'empty topic': {
    lossless: true,
    shape: 'stream token',
    mint: async (p, t) => (await p.fetchRecent({ topic: t, limit: LIMIT })).nextCursor,
  },
  'single-message topic': {
    lossless: true,
    shape: 'event id',
    mint: async (p, t) => {
      await p.post(t, WRITER, 'seed');
      return (await p.fetchRecent({ topic: t, limit: LIMIT })).nextCursor;
    },
  },
  'window that was all foreign': {
    lossless: true,
    shape: 'stream token',
    mint: async (p, t) => {
      for (let i = 0; i < LIMIT * 2; i++)
        fake.addMessage('someone-elses-topic', `n${i}`, aliasForTopic(String(t), true));
      return (await p.fetchRecent({ topic: t, limit: LIMIT })).nextCursor;
    },
  },
  'catch-up that crossed a page-sized foreign block': {
    lossless: true,
    shape: 'event id',
    mint: async (p, t) => {
      const seed = await p.post(t, WRITER, 'seed');
      for (let i = 0; i < LIMIT * 2; i++) fake.addMessage('someone-elses-topic', `n${i}`);
      return (await p.fetchRecent({ topic: t, since: asCursor(String(seed)), limit: LIMIT }))
        .nextCursor;
    },
  },
  'purged event id': {
    lossless: false,
    shape: 'not minted by this plugin',
    mint: async () => asCursor('$purged-by-retention:fake'),
  },
};

describe('cursor contract: a minted cursor replays to everything after it, never a truncated window', () => {
  for (const [originName, origin] of Object.entries(CURSOR_ORIGINS)) {
    for (const after of [0, LIMIT - 1, LIMIT, LIMIT * 3]) {
      it(`${originName} + ${after} later message(s): the replay drains all of them`, async () => {
        const p = await connectFake({ shared: true });
        const t = asTopic('ctx-payments');
        const cursor = await origin.mint(p, t);
        expect(SHAPES[origin.shape].is(cursor)).toBe(true);

        const expected: string[] = [];
        for (let i = 0; i < after; i++) {
          expected.push(`p-${i}`);
          await p.post(t, WRITER, `p-${i}`);
        }

        const { contents, finalCursor } = await drainFrom(p, t, cursor, LIMIT);
        const got = contents.filter((c) => c.startsWith('p-'));
        if (origin.lossless) {
          expect(got).toEqual(expected);
        } else {
          expect(got).toEqual(expected.slice(expected.length - got.length));
        }

        // …and the cursor the replay ends on is itself at the tail (replaying it yields nothing).
        const tail = await p.fetchRecent({ topic: t, since: finalCursor, limit: LIMIT });
        expect(tail.messages).toEqual([]);
        await p.disconnect();
      });
    }
  }

  /**
   * CLASS: a cursor's POSITION, as distinct from its replayability. Every case above grades what a
   * cursor DRAINS, which a token minted at the room's beginning satisfies just as well as one minted
   * at the tip — it simply re-reads history the session has already seen (in `shared_room` mode,
   * every topic's). The discriminating property is stability: replaying a cursor minted on a window
   * that gained nothing must return no messages AND the same cursor back. Parameterized over how
   * many backward pages the window had to walk, because that is what makes a first-page token and a
   * last-page token differ at all.
   */
  for (const pages of [1, 2, 5]) {
    it(`a window that walked ${pages} backward page(s) mints a cursor that stays put`, async () => {
      const p = await connectFake({ shared: true });
      const t = asTopic('ctx-payments');
      for (let i = 0; i < pages * LIMIT; i++)
        fake.addMessage(FOREIGN, `n${i}`, aliasForTopic(String(t), true));

      const minted = (await p.fetchRecent({ topic: t, limit: LIMIT })).nextCursor;
      const replay = await p.fetchRecent({ topic: t, since: minted, limit: LIMIT });

      expect(replay.messages).toEqual([]);
      expect(String(replay.nextCursor)).toBe(String(minted));
      await p.disconnect();
    });
  }

  it('a topic whose room does not exist yet mints a cursor that stays put', async () => {
    fake.aliasExists = false; // a read never provisions, so there is no timeline to name a token in
    const p = await connectFake({ shared: true });
    const t = asTopic('never-created');

    const minted = (await p.fetchRecent({ topic: t, limit: LIMIT })).nextCursor;
    const replay = await p.fetchRecent({ topic: t, since: minted, limit: LIMIT });

    expect(String(minted)).toBe('@parley-stream:');
    expect(SHAPES['stream token'].is(minted)).toBe(true);
    expect(replay.messages).toEqual([]);
    expect(String(replay.nextCursor)).toBe(String(minted));
    await p.disconnect();
  });

  it('an empty window never mints a cursor that resolves as "expired"', async () => {
    const p = await connectFake({ shared: true });
    const t = asTopic('never-written');

    const { nextCursor } = await p.fetchRecent({ topic: t, limit: LIMIT });

    expect(String(nextCursor)).not.toBe('');
    // Replaying it must not detour through the expired-cursor fallback: after posting more than a
    // full window, every message is still delivered.
    const expected: string[] = [];
    for (let i = 0; i < LIMIT * 2; i++) {
      expected.push(`p-${i}`);
      await p.post(t, WRITER, `p-${i}`);
    }
    const { contents } = await drainFrom(p, t, nextCursor, LIMIT);
    expect(contents).toEqual(expected);
    await p.disconnect();
  });
});

/**
 * CLASS: a read that SHORT-CIRCUITS may never report a position behind the caller's. Every case
 * above drives a read that runs to completion, where the paging loop has always executed at least
 * one page; a read that is torn down, retired by a reconnect, or refused by the homeserver executes
 * none — and a cursor minted for a window nobody looked at is a claim about a position nobody
 * observed. The stream form with no token is the dangerous one: it means "the first visible event in
 * the room", and core's catch-up persists whatever cursor it is handed, so the next start drains the
 * room from event 0 with a fresh seen-set and re-delivers all of it into agent context — in
 * `shared_room` mode, every topic's.
 */
const HISTORY = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'];

/**
 * Traffic NEWER than the topic's own history, of both kinds a read pages past — another topic's
 * messages and non-`m.room.message` events. The depths span every way the backward walk's FIRST page
 * can land: full of belonging messages, part-full, and holding none. Keep the ones past zero, so that
 * the last two are generated rather than hoped for — against the homogeneous history every row here
 * had before, page one always fills and the walk stops because it is finished, so the short circuit
 * is never what ended it and the position reported is never one the walk failed to reach.
 */
const TAIL_NOISE_DEPTHS = [0, LIMIT - 1, LIMIT, LIMIT * 3];

const addTailNoise = (f: FakeSynapse, depth: number): void => {
  for (let i = 0; i < depth; i++) {
    if (i % 2 === 0) f.addMessage(FOREIGN, `tail${i}`);
    else f.addRaw('m.reaction');
  }
};

/**
 * A count no bounded walk could reach, so a walk that lost its bound is a failed probe rather than a
 * hung run.
 */
const RUNAWAY_PAGES = 10_000;

/**
 * How many backward pages a since-less read will fetch before it gives up — OBSERVED, by serving one
 * a timeline that never runs out and counting what it asks for. Keep it observed rather than
 * imported: the number is the walk's own, so a fixture sized from it cannot quietly stop burying
 * anything the day it moves, and grading it costs this package no widened surface. It also grades
 * the bound's EXISTENCE, because an unbounded walk never returns a count at all.
 */
async function observeBackwardPageBound(): Promise<number> {
  const homeserver = new FakeSynapse();
  const restore = globalThis.fetch;
  let pages = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String((input as Request).url ?? input));
    if (!/\/rooms\/[^/]+\/messages$/.test(url.pathname) || url.searchParams.get('dir') !== 'b') {
      return homeserver.fetch(input, init);
    }
    pages++;
    if (pages > RUNAWAY_PAGES) throw new Error('the backward walk paged past every plausible bound');
    // A page that is always full, never the end of the timeline, and holds nothing the read can
    // collect — so the ONLY thing that can stop the walk is its own page budget.
    const width = Number(url.searchParams.get('limit') ?? '1');
    const chunk = Array.from({ length: width }, (_, i) => ({
      type: 'm.reaction',
      event_id: `$endless${pages}-${i}:fake`,
      sender: '@someone:fake',
      origin_server_ts: 1,
      content: {},
    }));
    return new Response(JSON.stringify({ chunk, start: 'p1', end: 'p0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  try {
    const p = await connectFake({});
    await p.fetchRecent({ topic: asTopic('page-bound-probe'), limit: LIMIT });
    await p.disconnect();
  } finally {
    globalThis.fetch = restore;
  }
  return pages;
}

const OBSERVED_PAGE_BOUND = await observeBackwardPageBound();

/**
 * Tail noise deep enough that the backward walk spends its whole page budget before it reaches the
 * oldest of {@link HISTORY}. Sized to leave `LIMIT - 1` of the topic still within reach, so the walk
 * ends holding PART of a window: the cell where "it filled the window" and "it ran out of timeline"
 * are both false and only the bound is left.
 */
const PAGE_BOUND_NOISE = OBSERVED_PAGE_BOUND * LIMIT - (LIMIT - 1);

/** How the read under test is prevented from completing normally. */
const SHORT_CIRCUITS: Record<
  string,
  {
    /** A transport FAULT, for which rejecting is the honest answer; a teardown is not one. */
    faults: boolean;
    /** Set where only one tail depth can produce the stop reason this row names. */
    depths?: number[];
    run: (p: MatrixPlugin, drive: () => Promise<FetchRecentResult>) => Promise<FetchRecentResult>;
  }
> = {
  'disconnect at the room-resolve await boundary': {
    faults: false,
    run: async (p, drive) => {
      const pending = drive();
      // Keep a handler on it across the lifecycle call, so that a read which rejects while that call
      // is in flight is not ALSO an unhandled rejection — which fails the run under a different name.
      void pending.catch(() => undefined);
      await p.disconnect();
      return pending;
    },
  },
  'disconnect before the room is resolved': {
    faults: false,
    run: async (p, drive) => {
      // A read whose room cache is cold must resolve the alias first, and a teardown there leaves it
      // with no room at all — the one path where an empty stream token is legitimate (a topic with
      // provably no history behind it), and therefore the one where minting it for a position the
      // teardown stopped it from observing is invisible.
      (p as unknown as { rooms: Map<string, unknown> }).rooms.clear();
      const pending = drive();
      void pending.catch(() => undefined);
      await p.disconnect();
      return pending;
    },
  },
  'disconnect mid-page': {
    faults: false,
    run: async (p, drive) => {
      fake.onRequest = (_method, path) => {
        if (!path.endsWith('/messages')) return;
        fake.onRequest = () => undefined;
        void p.disconnect();
      };
      return drive();
    },
  },
  'every /messages page 500s': {
    faults: true,
    run: async (_p, drive) => {
      fake.messagesFailures = Number.POSITIVE_INFINITY;
      return drive();
    },
  },
  'a bare connect() retires the generation': {
    faults: false,
    run: async (p, drive) => {
      const pending = drive();
      void pending.catch(() => undefined);
      await p.connect(fakeConfig({ shared: true }));
      return pending;
    },
  },
  // Nothing interferes with this one: the walk's OWN page bound is what ends it. A bound is not a
  // teardown — every later call hits the same one — so this row is the control that separates
  // "stopped early and has no position" from "stopped early and must still report the position it
  // reached", which the rows above cannot tell apart.
  'the walk spends its page budget': {
    faults: false,
    depths: [PAGE_BOUND_NOISE],
    run: async (_p, drive) => drive(),
  },
};

/** Every cursor form a caller can arrive with, including the two this plugin mints itself. */
const SINCE_FORMS: Record<string, (p: MatrixPlugin, t: Topic) => Promise<Cursor | undefined>> = {
  'no since': async () => undefined,
  'a minted event id': async (p, t) => (await p.fetchRecent({ topic: t, limit: LIMIT })).nextCursor,
  'a minted stream token': async (p) =>
    (await p.fetchRecent({ topic: asTopic('a-topic-with-no-messages'), limit: LIMIT })).nextCursor,
  'a purged event id': async () => asCursor('$purged-by-retention:fake'),
};

describe('a read that never completed reports the caller position, never one behind it', () => {
  it('the page-bound row leaves part of a window in reach and the rest out of it', () => {
    // The probe answered at all, so the walk is bounded — and by something it chose, not by a
    // timeline that ran out or a page it could not ask for.
    expect(OBSERVED_PAGE_BOUND).toBeGreaterThan(1);
    expect(OBSERVED_PAGE_BOUND).toBeLessThan(RUNAWAY_PAGES);
    const stillInReach = OBSERVED_PAGE_BOUND * LIMIT - PAGE_BOUND_NOISE;
    expect(stillInReach).toBeGreaterThan(0);
    expect(stillInReach).toBeLessThan(LIMIT);
    expect(HISTORY.length).toBeGreaterThan(stillInReach);
  });

  for (const [sinceName, mintSince] of Object.entries(SINCE_FORMS)) {
    for (const [circuitName, circuit] of Object.entries(SHORT_CIRCUITS)) {
      for (const depth of circuit.depths ?? TAIL_NOISE_DEPTHS) {
        it(`${sinceName} / ${circuitName} / tail noise x${depth}: the cursor it reports replays nothing already delivered`, async () => {
          const p = await connectFake({ shared: true });
          const t = asTopic('ctx-payments');
          for (const c of HISTORY) await p.post(t, WRITER, c);
          const since = await mintSince(p, t);
          addTailNoise(fake, depth);

          const outcome = await circuit
            .run(p, () => p.fetchRecent({ topic: t, since, limit: LIMIT }))
            .catch((err: unknown) => err as Error);

          if (since !== undefined && !circuit.faults) {
            expect(
              outcome,
              'a teardown that was handed a caller position can always report it back',
            ).not.toBeInstanceOf(Error);
          }
          if (outcome instanceof Error) return; // no cursor reported at all cannot regress one.

          // Every row here reads a room that exists and holds history, so the tokenless stream form
          // — "the first visible event in the room" — names a position no walk in this block ever
          // reached, whichever way the read was cut short.
          expect(String(outcome.nextCursor)).not.toBe('@parley-stream:');

          const q = await connectFake({ shared: true });
          // What the caller could still legitimately be shown: everything its OWN position replays to,
          // less whatever this call just handed it. A since-less caller's position IS the seam's
          // recent window, so it sits at the tail only once that window has actually reached it —
          // taking the entitlement from what was delivered instead lets a read that delivered nothing
          // claim to owe nothing.
          const delivered = outcome.messages.map((m) => m.content);
          const reachable =
            since === undefined
              ? (await q.fetchRecent({ topic: t, limit: LIMIT })).messages.map((m) => m.content)
              : (await drainFrom(q, t, since, LIMIT)).contents;
          const owed = reachable.filter((c) => !delivered.includes(c));

          expect((await drainFrom(q, t, outcome.nextCursor, LIMIT)).contents).toEqual(owed);

          // …and the position it reported is one the stream can still MOVE from. `owed` is computed
          // the same way the read under test computes its own answer, so a cursor that reports
          // nothing and advances nowhere satisfies it vacuously; what such a cursor cannot do is
          // deliver the next message to land.
          await q.post(t, WRITER, 'after-the-read');
          expect((await drainFrom(q, t, outcome.nextCursor, LIMIT)).contents.at(-1)).toBe(
            'after-the-read',
          );
          await q.disconnect();
          await p.disconnect();
        });
      }
    }
  }
});
