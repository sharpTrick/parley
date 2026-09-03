import { describe, expect, it } from 'vitest';
import { asHandle, asTopic } from '../message.js';
import type { BackendPlugin } from '../seam.js';
import { FakePlugin } from './fake-plugin.js';

/**
 * A shared fake that implements a seam clause BACKWARDS is worse than no coverage: every test built
 * on it stays green while grading the opposite of production. That is what happened here — a
 * since-less `fetchRecent` answered with the OLDEST page while `seam.ts` ("the backend's default
 * recent window") and every shipped backend answer with the NEWEST, so cold-start catch-up was
 * graded at the wrong end of history, and the one grid that needed the real clause had to carry its
 * own private fake to get it.
 *
 * The conformance suite already grades this clause against every shipped plugin; core's fake is the
 * half that sits outside it, so it is graded here against the same clause.
 */
describe('FakePlugin implements the seam clauses core tests rely on', () => {
  const T = asTopic('ctx');
  const me = asHandle('alice');

  async function seeded(n: number): Promise<FakePlugin> {
    const p = new FakePlugin();
    await p.connect({});
    for (let i = 1; i <= n; i++) await p.post(T, me, `m${i}`);
    return p;
  }

  // (messages posted, page size) — straddling the limit in both directions, at a page size a
  // caller-driven fetch can actually ask for.
  it.each([
    [501, 500],
    [500, 500],
    [500, 499],
    [3, 1],
    [1, 1],
  ])('a since-less fetch of %i messages at limit %i returns the NEWEST page', async (total, limit) => {
    const p = await seeded(total);
    const page = await p.fetchRecent({ topic: T, limit });

    const kept = Math.min(total, limit);
    const newest = Array.from({ length: kept }, (_u, i) => `m${total - kept + i + 1}`);
    expect(page.messages.map((m) => m.content)).toEqual(newest);
    expect(page.nextCursor).toBe(page.messages.at(-1)!.cursor);

    // The cursor a page hands back is replayable: resuming from it yields nothing and stands still.
    const drained = await p.fetchRecent({ topic: T, since: page.nextCursor, limit });
    expect(drained.messages).toEqual([]);
    expect(drained.nextCursor).toBe(page.nextCursor);
  });

  it('a since-ful fetch still pages forward from the OLDEST unread', async () => {
    const p = await seeded(5);
    const page = await p.fetchRecent({ topic: T, since: (await p.fetchRecent({ topic: T, limit: 5 })).messages[0]!.cursor, limit: 2 });
    expect(page.messages.map((m) => m.content)).toEqual(['m2', 'm3']);
  });

  it('an empty topic answers with a replayable zero cursor either way', async () => {
    const p = await seeded(0);
    const cold = await p.fetchRecent({ topic: T, limit: 10 });
    expect(cold.messages).toEqual([]);
    const resumed = await p.fetchRecent({ topic: T, since: cold.nextCursor, limit: 10 });
    expect(resumed.messages).toEqual([]);
    expect(resumed.nextCursor).toBe(cold.nextCursor);
  });
});

/**
 * A fake that keeps serving after `disconnect()` cannot fail the way a backend fails, so every core
 * test grading teardown ORDERING is graded against something with no opinion about it: a post onto
 * a closed connection still lands, and the swallowed error nobody would ever see in production is a
 * green row here. The conformance suite's reference plugin refuses the call, and
 * so does every shipped backend.
 *
 * The rule is over every BackendPlugin implementation bridge-core defines — found by importing the
 * tree and asking each export whether it implements the seam, never by naming a file — so the next
 * fake is graded on the clause the day it is written, wherever it is put.
 */
describe('every fake core is graded against refuses the seam while disconnected', () => {
  const T = asTopic('ctx');
  const me = asHandle('alice');

  const CALLS: Record<string, (p: BackendPlugin) => Promise<unknown>> = {
    post: (p) => p.post(T, me, 'x'),
    fetchRecent: (p) => p.fetchRecent({ topic: T }),
    subscribe: (p) => p.subscribe(T, () => undefined),
    resolveIdentity: (p) => p.resolveIdentity(me),
  };

  /** A lifecycle state, and whether a live backend would serve a seam call made in it. */
  const STATES: Array<[state: string, reach: (p: BackendPlugin) => Promise<void>, served: boolean]> = [
    ['never connected', async () => undefined, false],
    [
      'connected',
      async (p) => {
        await p.connect({});
      },
      true,
    ],
    [
      'after disconnect',
      async (p) => {
        await p.connect({});
        await p.disconnect();
      },
      false,
    ],
    [
      'reconnected',
      async (p) => {
        await p.connect({});
        await p.disconnect();
        await p.connect({});
      },
      true,
    ],
  ];

  type SeamClass = new () => BackendPlugin;
  const SEAM = ['connect', 'disconnect', 'subscribe', 'post', 'fetchRecent', 'resolveIdentity'] as const;

  const discovered: Array<[origin: string, make: SeamClass]> = Object.entries(
    import.meta.glob<Record<string, unknown>>(['../**/*.ts', '!../**/*.test.ts'], { eager: true }),
  )
    .flatMap(([path, module]) =>
      Object.entries(module).flatMap(([name, value]) => {
        if (typeof value !== 'function') return [];
        const proto = (value as { prototype?: Record<string, unknown> }).prototype;
        if (proto === undefined || proto === null) return [];
        const implementsSeam = SEAM.every((method) => typeof proto[method] === 'function');
        return implementsSeam ? [[`${path}#${name}`, value as SeamClass] as [string, SeamClass]] : [];
      }),
    );

  // Without this the table below is vacuous the moment the sweep stops finding anything — a fake
  // rewritten as a factory, a glob that stops matching — and would report green having graded
  // nothing at all. Anchored on the imported SYMBOL, so that moving the file it lives in is not
  // itself a failure.
  it('found the fakes it is meant to grade', () => {
    expect(discovered.map(([, make]) => make)).toContain(FakePlugin);
  });

  const CELLS = discovered.flatMap(([origin, make]) =>
    STATES.flatMap(([state, reach, served]) =>
      Object.keys(CALLS).map((call) => [`${origin} ${state}`, call, make, reach, served] as const),
    ),
  );

  it.each(CELLS)('%s: %s()', async (_where, call, make, reach, served) => {
    const plugin = new make();
    await reach(plugin);
    const outcome = await CALLS[call]!(plugin).then(
      () => 'served' as const,
      () => 'refused' as const,
    );
    expect(outcome).toBe(served ? 'served' : 'refused');
  });
});
