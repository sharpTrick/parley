import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asBackendMsgId, asCursor, asHandle, asTopic, type Message } from '../message.js';
import { NoSuchTopicError, type BackendPlugin, type FetchRecentArgs, type FetchRecentResult } from '../seam.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import {
  memoryReadState,
  NONCONFORMANT_SHAPE_NAMES,
  NONCONFORMANT_SHAPES,
  pagingProbe,
} from '../testing/nonconformant.js';
import { catchUpAll, catchUpTopic, MAX_CATCHUP_PAGES } from './catchup.js';
import { ReadStateStore } from './read-state.js';
import { SeenSet } from './seen-set.js';

const rsPath = () => join(mkdtempSync(join(tmpdir(), 'parley-cu-')), 'read-state.json');

/** Await a promise that MUST reject, and hand back the Error (never the resolved value). */
async function rejectionOf(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error('expected the promise to reject, but it resolved');
    },
    (e: unknown) => e as Error,
  );
}
const T = asTopic('ctx');
const me = asHandle('alice');

async function seeded(n: number, prefix = 'm') {
  const p = new FakePlugin();
  await p.connect({});
  for (let i = 0; i < n; i++) await p.post(T, me, `${prefix}${i}`);
  return p;
}

describe('catch-up driver', () => {
  it('drains all, warms the seen-set, advances read-state', async () => {
    const p = await seeded(5);
    const readState = new ReadStateStore(rsPath());
    const seen = new SeenSet();
    const n = await catchUpTopic({ plugin: p, topic: T, limit: 100, readState, seen });
    expect(n).toBe(5);
    expect(readState.get(T)).toBe('5'); // cursor of the last message
    expect(seen.has(T, asBackendMsgId('5'))).toBe(true);
    // warmed: a message already pulled should NOT count as first-seen on the push path
    expect(seen.firstSeen(T, asBackendMsgId('3'))).toBe(false);
  });

  /**
   * The driver writes whatever `nextCursor` a page carried straight into read-state, and the seam's
   * TYPE is no guarantee — a JS plugin, or a TS one returning a value typed away, can omit it. The
   * persisted position is the only thing standing between a restart and a cold re-drain, so require
   * that a page core cannot use fails on the page that produced it rather than erasing the position.
   */
  it.each([
    ['no nextCursor at all', {}],
    ['a null nextCursor', { nextCursor: null }],
    ['a numeric nextCursor', { nextCursor: 7 }],
    ['an empty-string nextCursor', { nextCursor: '' }],
  ])('a page carrying %s leaves the stored read position intact', async (_label, over) => {
    const path = rsPath();
    const readState = new ReadStateStore(path);
    readState.set(T, asCursor('42'));
    const plugin = {
      fetchRecent: (): Promise<FetchRecentResult> =>
        Promise.resolve({ messages: [], ...over } as unknown as FetchRecentResult),
    } as unknown as BackendPlugin;

    await expect(
      catchUpTopic({ plugin, topic: T, limit: 10, readState, seen: new SeenSet() }),
    ).rejects.toThrow(TypeError);
    expect(readState.get(T)).toBe('42');
    expect(new ReadStateStore(path).get(T)).toBe('42');
  });

  it('second catch-up returns only newer (exclusive since)', async () => {
    const p = await seeded(3, 'a');
    const readState = new ReadStateStore(rsPath());
    const seen = new SeenSet();
    expect(await catchUpTopic({ plugin: p, topic: T, limit: 100, readState, seen })).toBe(3);
    for (let i = 0; i < 2; i++) await p.post(T, me, `b${i}`);
    expect(await catchUpTopic({ plugin: p, topic: T, limit: 100, readState, seen })).toBe(2);
    expect(readState.get(T)).toBe('5');
    // fully drained → no further messages
    expect(await catchUpTopic({ plugin: p, topic: T, limit: 100, readState, seen })).toBe(0);
  });

  // Keep cold-start out of any case named for pagination, so that a since-less drain is never
  // asserted to reach the whole history: with no stored cursor the driver reads the newest `limit`
  // window and adopts its tail. Both arms are pinned by the stored-cursor × page-size grid below.

  describe('resume-from-disk failures carry an actionable hint', () => {
    const rejectingPlugin = (message: string) =>
      ({
        fetchRecent: () => Promise.reject(new Error(message)),
      }) as unknown as Parameters<typeof catchUpTopic>[0]['plugin'];

    it.each([
      ['invalid input syntax for type bigint: "1785300194045-0"'], // postgres given a redis id
      ['ERR Invalid stream ID specified as stream command argument'], // redis given a bigserial
      ['M_INVALID_PARAM: invalid from token'], // matrix given anything else
    ])('names the state file and the stored cursor (%s)', async (backendError) => {
      const path = rsPath();
      const readState = new ReadStateStore(path);
      readState.set(T, '1785300194045-0' as never);

      await expect(
        catchUpTopic({
          plugin: rejectingPlugin(backendError),
          topic: T,
          limit: 100,
          readState,
          seen: new SeenSet(),
        }),
      ).rejects.toThrow(
        new RegExp(
          `resuming from the stored cursor.*1785300194045-0.*${backendError.slice(0, 12)}`,
          's',
        ),
      );
      const err = await rejectionOf(
        catchUpTopic({
          plugin: rejectingPlugin(backendError),
          topic: T,
          limit: 100,
          readState,
          seen: new SeenSet(),
        }),
      );
      expect(err.message).toContain(path);
      // Assert on `stack`, not only `message`, so that a wrapper which clobbers the stack cannot
      // discard the hint at the one place a human reads it while this test stays green.
      expect(err.stack).toContain('resuming from the stored cursor');
      expect(err.stack).toContain(path);
      expect((err.cause as Error).message).toBe(backendError);
    });

    /**
     * The hint names a state file and advises deleting it, so it belongs to the ONE page that
     * replays a cursor read off disk and to no other: told it about a transient mid-pagination blip,
     * an operator deletes read-state and re-drains the whole history. Cross "was a cursor stored"
     * with which page rejects — exactly one cell is annotated, so widening the scope to every page
     * and narrowing it to none each flip a cell.
     */
    describe('the resume hint is scoped to the page that replays the stored cursor', () => {
      /** Serves one message per page with an advancing cursor, rejecting on the chosen page. */
      const failingOnPage = (failAt: number): BackendPlugin => {
        let page = 0;
        return {
          fetchRecent: (a: FetchRecentArgs): Promise<FetchRecentResult> => {
            const n = page++;
            if (n === failAt) return Promise.reject(new Error('ECONNRESET'));
            return Promise.resolve({
              messages: [
                {
                  topic: a.topic,
                  senderHandle: me,
                  content: `m${n}`,
                  timestamp: '1970-01-01T00:00:00.000Z',
                  backendMsgId: asBackendMsgId(String(n)),
                  cursor: asCursor(String(n + 1)),
                  mentions: [],
                } as Message,
              ],
              nextCursor: asCursor(String(n + 1)),
            });
          },
        } as unknown as BackendPlugin;
      };

      const CELLS = [true, false].flatMap((resumed) =>
        [0, 1, 3].map((failAt) => [resumed, failAt] as const),
      );

      it.each(CELLS)('stored cursor=%s, page %i rejects', async (resumed, failAt) => {
        const path = rsPath();
        const readState = new ReadStateStore(path);
        if (resumed) readState.set(T, asCursor('0'));

        const err = await rejectionOf(
          catchUpTopic({
            plugin: failingOnPage(failAt),
            topic: T,
            limit: 1,
            readState,
            seen: new SeenSet(),
          }),
        );

        if (resumed && failAt === 0) {
          expect(err.message).toMatch(/resuming from the stored cursor/);
          expect(err.message).toContain(path);
          expect(err.message).toMatch(/instance_id/);
          expect((err.cause as Error).message).toBe('ECONNRESET');
        } else {
          expect(err.message).toBe('ECONNRESET');
          expect(err.cause).toBeUndefined();
        }
      });
    });
  });

  /**
   * seam.ts declares NoSuchTopicError the ONE rejection meaning "topic not present yet" rather than
   * a backend failure. Table every catch-up entry point against BOTH kinds so a call site that
   * honours the sentinel on one path and not its siblings cannot pass: the sentinel must degrade
   * (zero messages, read-state untouched, bridge alive), the generic error must propagate.
   */
  describe('the absent-topic sentinel degrades; every other rejection propagates', () => {
    const rejectingWith = (make: () => Error, only?: string): BackendPlugin =>
      ({
        fetchRecent: (a: FetchRecentArgs) =>
          only === undefined || a.topic === only
            ? Promise.reject(make())
            : Promise.resolve({ messages: [] as Message[], nextCursor: asCursor('9') }),
      }) as unknown as BackendPlugin;

    const sentinel = (): Error => new NoSuchTopicError('ops');
    const generic = (): Error => new Error('backend on fire');

    const entryPoints: Array<
      [name: string, run: (plugin: BackendPlugin, readState: ReadStateStore) => Promise<number>]
    > = [
      [
        'catchUpTopic',
        (plugin, readState) =>
          catchUpTopic({ plugin, topic: asTopic('ops'), limit: 100, readState, seen: new SeenSet() }),
      ],
      [
        'catchUpAll',
        (plugin, readState) =>
          catchUpAll({
            plugin,
            topics: [asTopic('ctx'), asTopic('ops')],
            limit: 100,
            readState,
            seen: new SeenSet(),
          }),
      ],
    ];

    for (const [name, run] of entryPoints) {
      for (const cold of [true, false]) {
        const start = cold ? 'cold start' : 'resuming from a stored cursor';

        it(`${name} treats NoSuchTopicError as an empty topic (${start})`, async () => {
          const readState = new ReadStateStore(rsPath());
          if (!cold) readState.set(asTopic('ops'), asCursor('stored'));
          const drained = await run(rejectingWith(sentinel, 'ops'), readState);
          expect(drained).toBe(0);
          // Read-state must not move for a topic we never actually read.
          expect(readState.get(asTopic('ops'))).toBe(cold ? undefined : 'stored');
        });

        it(`${name} propagates a generic backend failure (${start})`, async () => {
          const readState = new ReadStateStore(rsPath());
          if (!cold) readState.set(asTopic('ops'), asCursor('stored'));
          await expect(run(rejectingWith(generic, 'ops'), readState)).rejects.toThrow(
            /backend on fire/,
          );
        });
      }
    }

    it('catchUpAll keeps draining the healthy topics around an absent one', async () => {
      const p = await seeded(4);
      const absent = {
        fetchRecent: (a: FetchRecentArgs) =>
          a.topic === 'ops' ? Promise.reject(new NoSuchTopicError('ops')) : p.fetchRecent(a),
      } as unknown as BackendPlugin;
      const readState = new ReadStateStore(rsPath());
      const total = await catchUpAll({
        plugin: absent,
        topics: [asTopic('ops'), T, asTopic('ops')],
        limit: 100,
        readState,
        seen: new SeenSet(),
      });
      expect(total).toBe(4);
      expect(readState.get(T)).toBe('4');
    });

  });

  /**
   * How much a cold start actually drains is a function of BOTH inputs — stored cursor and page
   * size — and the loop silently reads only the newest window when there is no cursor. Pin the
   * exact drained count and final read-state per cell, against the SHARED fake: a bespoke
   * conformant-window plugin here would leave the shared one free to keep answering a since-less
   * read backwards, which is how this grid came to be the only place the clause was visible.
   */
  describe('drained window depends on stored-cursor × page-size', () => {
    it.each([
      // stored cursor | total | limit | drained | final read-state
      [undefined, 2, 3, 2, '2'],
      [undefined, 3, 3, 3, '3'],
      [undefined, 10, 3, 3, '10'], // cold start adopts the newest window's tail: 7 rows never drained
      [undefined, 1000, 100, 100, '1000'],
      ['0', 2, 3, 2, '2'],
      ['0', 3, 3, 3, '3'],
      ['0', 10, 3, 10, '10'], // resumed catch-up pages to exhaustion
      ['5', 10, 3, 5, '10'],
    ])(
      'stored=%s total=%i limit=%i drains %i and leaves read-state at %s',
      async (stored, total, limit, drained, finalCursor) => {
        const readState = new ReadStateStore(rsPath());
        if (stored !== undefined) readState.set(T, asCursor(stored));
        const n = await catchUpTopic({
          plugin: await seeded(total),
          topic: T,
          limit,
          readState,
          seen: new SeenSet(),
        });
        expect(n).toBe(drained);
        expect(readState.get(T)).toBe(finalCursor);
      },
    );
  });

  /**
   * A page's LENGTH proves nothing: the seam promises only "max messages to return in this page",
   * and the backends whose ceiling is not negotiable (Discord's 100, Telegram, Matrix `/messages`)
   * return short pages with more behind them. So the driver's stop rule is an EMPTY page, and every
   * other adversarial shape must still terminate in a bounded number of calls rather than wedging
   * startup. Run the whole shape table, not the one shape whose guard this file happens to own.
   */
  describe('a non-conformant backend can neither wedge nor short-change catch-up', () => {
    it.each(NONCONFORMANT_SHAPE_NAMES)('%s', async (name) => {
      const { serve, drains } = NONCONFORMANT_SHAPES[name]!;
      const { plugin, calls } = pagingProbe(serve);
      const drained = await catchUpTopic({
        plugin,
        topic: T,
        limit: 1_000,
        readState: memoryReadState() as unknown as ReadStateStore,
        seen: new SeenSet(),
      });
      expect(calls.length).toBeLessThanOrEqual(MAX_CATCHUP_PAGES);
      if (drains !== undefined) expect(drained).toBe(drains);
    });

    it('a topic whose pages never stop arriving stops at the page ceiling', async () => {
      const { plugin, calls } = pagingProbe(NONCONFORMANT_SHAPES['a cursor that walks backwards, then forwards again']!.serve);
      await catchUpTopic({
        plugin,
        topic: T,
        limit: 1_000,
        readState: memoryReadState() as unknown as ReadStateStore,
        seen: new SeenSet(),
      });
      expect(calls).toHaveLength(MAX_CATCHUP_PAGES);
    });

    // Every page rewrites the state file, so an unbounded loop is a disk hazard as well as a CPU
    // one: the ceiling has to hold with the REAL store, not only the in-memory stand-in above.
    it('a stuck cursor stops before it can rewrite the state file more than a handful of times', async () => {
      const path = rsPath();
      const readState = new ReadStateStore(path);
      const { plugin, calls } = pagingProbe(
        NONCONFORMANT_SHAPES['a full page whose cursor never advances']!.serve,
      );
      await catchUpTopic({ plugin, topic: T, limit: 1_000, readState, seen: new SeenSet() });
      expect(calls.length).toBeLessThan(5);
      expect(new ReadStateStore(path).get(T)).toBe('stuck');
    });

    /**
     * What the seam's byte-stability requirement BUYS, graded as the difference between two plugins
     * standing at the same position. The brake is `nextCursor === since`, so a plugin that re-mints
     * a semantically identical cursor per call (re-serialised object, re-rendered timestamp) buys
     * itself the page ceiling instead of one wasted round-trip. A doc that tells a plugin author
     * core "never compares" a cursor is describing the left-hand column and shipping the right one.
     */
    const pagesUntilStop = async (shape: string): Promise<number> => {
      const { plugin, calls } = pagingProbe(NONCONFORMANT_SHAPES[shape]!.serve);
      await catchUpTopic({
        plugin,
        topic: T,
        limit: 1_000,
        readState: memoryReadState() as unknown as ReadStateStore,
        seen: new SeenSet(),
      });
      return calls.length;
    };

    it('brakes on a no-progress cursor only while the plugin spells it the same way twice', async () => {
      expect(await pagesUntilStop('a full page whose cursor never advances')).toBeLessThan(5);
      expect(
        await pagesUntilStop('a full page whose cursor names one position but is spelled differently each call'),
      ).toBe(MAX_CATCHUP_PAGES);
    });
  });

  it('catchUpAll loops over every configured topic', async () => {
    const p = new FakePlugin();
    await p.connect({});
    const A = asTopic('a');
    const B = asTopic('b');
    await p.post(A, me, 'x');
    await p.post(B, me, 'y');
    await p.post(B, me, 'z');
    const readState = new ReadStateStore(rsPath());
    const seen = new SeenSet();
    expect(await catchUpAll({ plugin: p, topics: [A, B], limit: 100, readState, seen })).toBe(3);
    expect(readState.get(A)).toBe('1');
    expect(readState.get(B)).toBe('3');
  });
});
