import { runConformanceSuite } from '@sharptrick/parley-conformance';
import type { BackendPlugin, Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { makeReferenceContext, makeThrowingReferenceContext } from './reference-plugin.js';

// The suite's positive control, and the only run of it that needs no server: an in-memory plugin
// the repo controls, which must pass in full. Both arms of the seam's absent-topic MAY are covered
// here, because no shipped backend takes the throwing arm and nothing else would ever grade it.
runConformanceSuite('reference (in-memory)', makeReferenceContext);
runConformanceSuite('reference (NoSuchTopicError on an absent topic)', makeThrowingReferenceContext);

/**
 * `concurrentPost` is the only independent writer the context hands out, so the clause that grades
 * live delivery from one is worth nothing if the fixture quietly writes through `ctx.plugin`. Pinned
 * on the fixtures THIS package owns; deliberately not a suite clause, because a real fixture may
 * additionally count `ctx.plugin` as one of its contending writers — SQLite's does, to keep the
 * shipped `post()` under contention rather than a hand-rolled one.
 */
describe.each([
  ['reference (in-memory)', makeReferenceContext],
  ['reference (NoSuchTopicError on an absent topic)', makeThrowingReferenceContext],
])('%s hands out a genuinely independent writer', (_label, make) => {
  it('never routes concurrentPost through ctx.plugin', async () => {
    const ctx = await make();
    try {
      const t = ctx.freshTopic();
      const own: string[] = [];
      const real = ctx.plugin.post.bind(ctx.plugin);
      ctx.plugin.post = ((...args: Parameters<BackendPlugin['post']>) => {
        own.push(String(args[2]));
        return real(...args);
      }) as BackendPlugin['post'];

      const drive = ctx.concurrentPost as (t: Topic, w: number, p: number) => Promise<void>;
      await drive(t, 2, 1);

      expect(
        own,
        'concurrentPost wrote through ctx.plugin, so its writers are not independent',
      ).toEqual([]);
      expect((await ctx.plugin.fetchRecent({ topic: t })).messages).toHaveLength(2);
    } finally {
      await ctx.cleanup();
    }
  });
});
