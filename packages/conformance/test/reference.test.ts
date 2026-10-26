import { runConformanceSuite } from '@sharptrick/parley-conformance';
import type { BackendPlugin, Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import {
  makeBlockingReferenceContext,
  makeReferenceContext,
  makeStampedSenderReferenceContext,
  makeThrowingReferenceContext,
} from './reference-plugin.js';
import { CAPABILITY_AXES } from './suite-source.js';

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
// `reference (native blockMs)` covers the parking arm of the `blockMs` contract and
// `reference (in-memory)` the refusing one; an arm no fixture PASSES on is an arm whose assertions
// nothing in this repo can satisfy, which is indistinguishable from their being deleted.
for (const [label, make] of FIXTURES) runConformanceSuite(label, make);

/**
 * The positive-control half of the capability-arm class: an arm with no fixture that PASSES on it is
 * an arm whose assertions nothing in this repo can satisfy, and `negative-control` only demands a
 * fixture that fails.
 */
describe('the reference fixtures cover every arm of every capability', () => {
  const axisNamed = (name: string): (typeof CAPABILITY_AXES)[number] => {
    const axis = CAPABILITY_AXES.find((a) => a.name === name);
    if (axis === undefined) throw new Error(`no capability axis named ${name}`);
    return axis;
  };

  it.each(
    CAPABILITY_AXES.flatMap((a) => a.arms.map((arm) => [a.name, arm] as const)),
  )('some passing fixture declares `%s` = %s', async (name, arm) => {
    const axis = axisNamed(name);
    const contexts = await Promise.all(FIXTURES.map(async ([, make]) => make()));
    try {
      expect(
        contexts.filter((c) => axis.armOf(c) === arm).length,
        `no reference fixture takes the \`${name}: ${String(arm)}\` arm, so nothing in this ` +
          `repo demonstrates that arm's assertions are satisfiable at all`,
      ).toBeGreaterThan(0);
    } finally {
      await Promise.all(contexts.map((c) => c.cleanup().catch(() => undefined)));
    }
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
