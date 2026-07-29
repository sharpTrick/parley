import {
  asCursor,
  asHandle,
  asTopic,
  type BackendPlugin,
  type Cursor,
  type Topic,
} from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixPlugin } from '../src/index.js';
import { connectFake, FakeSynapse } from './fake-synapse.js';

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
 * How the cursor under test was minted. `lossless` marks the ones this plugin MINTED itself — those
 * must replay to everything after them. A cursor it never minted (purged / foreign) is allowed to
 * degrade to the documented recent window, but even then only ever to a SUFFIX: no mid-stream gap.
 *
 * `shape` enumerates every cursor FORM the plugin can emit, in one place a doc reviewer can diff
 * against the README: an `event_id`, or the opaque `@parley-stream:` pagination token minted for a
 * window that held no belonging message. A backend whose cursor is not uniformly one value type
 * documents both or misleads whoever reads a `read-state.json`.
 */
const SHAPES = {
  'event id': (c: Cursor) => /^\$/.test(String(c)),
  'stream token': (c: Cursor) => String(c).startsWith('@parley-stream:'),
  'not minted by this plugin': () => true,
} as const;

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
      for (let i = 0; i < LIMIT * 2; i++) fake.addMessage('someone-elses-topic', `n${i}`);
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
        expect(SHAPES[origin.shape](cursor)).toBe(true);

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
