import { CONTEXT_FIELDS, runConformanceSuite } from '@sharptrick/parley-conformance';
import type { BackendPlugin, Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import {
  makeBlockingReferenceContext,
  makeReferenceContext,
  makeStampedSenderReferenceContext,
  makeThrowingReferenceContext,
} from './reference-plugin.js';
import { BOOLEAN_CAPABILITIES } from './suite-source.js';

const FIXTURES: [string, () => Promise<import('@sharptrick/parley-conformance').ConformanceContext>][] =
  [
    ['reference (in-memory)', makeReferenceContext],
    ['reference (NoSuchTopicError on an absent topic)', makeThrowingReferenceContext],
    ['reference (native blockMs)', makeBlockingReferenceContext],
    ['reference (sender stamped, identity not carried)', makeStampedSenderReferenceContext],
  ];

// The suite's positive control, and the only run of it that needs no server: an in-memory plugin
// the repo controls, which must pass in full. Both arms of the seam's absent-topic MAY are covered
// here, because no shipped backend takes the throwing arm and nothing else would ever grade it.
// The last two cover the other arm of each BOOLEAN capability flag: with every fixture declaring
// `supportsBlockingFetch: false` the suite's whole native-blocking half ran nowhere, which is
// indistinguishable from its being deleted.
for (const [label, make] of FIXTURES) runConformanceSuite(label, make);

/**
 * The positive-control half of the capability-arm class: an arm with no fixture that PASSES on it is
 * an arm whose assertions nothing in this repo can satisfy, and `negative-control` only demands a
 * fixture that fails.
 */
describe('the reference fixtures cover both arms of every boolean capability', () => {
  it.each(BOOLEAN_CAPABILITIES.flatMap((f) => [true, false].map((arm) => [f, arm] as const)))(
    'some passing fixture declares `%s` = %s',
    async (field, arm) => {
      const contexts = await Promise.all(FIXTURES.map(async ([, make]) => make()));
      try {
        expect(
          contexts.filter((c) => (c as unknown as Record<string, unknown>)[field] === arm).length,
          `no reference fixture takes the \`${field}: ${String(arm)}\` arm, so nothing in this ` +
            `repo demonstrates that arm's assertions are satisfiable at all`,
        ).toBeGreaterThan(0);
      } finally {
        await Promise.all(contexts.map((c) => c.cleanup().catch(() => undefined)));
      }
    },
  );

  it('reads real capability fields, so the rows above are not an empty table', () => {
    expect(BOOLEAN_CAPABILITIES.every((f) => f in CONTEXT_FIELDS)).toBe(true);
    expect(BOOLEAN_CAPABILITIES.length).toBeGreaterThan(1);
  });
});

/**
 * `concurrentPost` is the only independent writer the context hands out, so the clause that grades
 * live delivery from one is worth nothing if the fixture quietly writes through `ctx.plugin`. Pinned
 * on the fixtures THIS package owns; deliberately not a suite clause, because a real fixture may
 * additionally count `ctx.plugin` as one of its contending writers — SQLite's does, to keep the
 * shipped `post()` under contention rather than a hand-rolled one.
 */
describe.each(FIXTURES)('%s hands out a genuinely independent writer', (_label, make) => {
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
