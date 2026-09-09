import { afterEach, beforeEach, describe, expect } from 'vitest';
import { blockingCases } from './cases/blocking.js';
import { catchUpCases } from './cases/catch-up.js';
import { concurrencyCases } from './cases/concurrency.js';
import { liveCases } from './cases/live.js';
import { postCases } from './cases/post.js';
import { toolSurfaceCases } from './cases/tool-surface.js';
import {
  type BackendFactory,
  CAPABILITY_FIELDS,
  type ConformanceContext,
  openContext,
} from './factory.js';

export {
  CALLER_BLOCK_FLOOR_FRACTION,
  CALLER_BLOCK_RETURN_MS,
  EARLY_RETURN_FRACTION,
  IDLE_BLOCK_CEILING_MS,
  IDLE_BLOCK_FLOOR_MS,
  IDLE_BLOCK_MS,
  OVERSHOOT_MULTIPLE,
  PARK_FRACTION,
  PROBE_MAX_BLOCK_MS,
  RACE_BLOCK_MS,
  RACE_RETURN_MS,
  REFUSAL_RETURN_MS,
  SERVED_BLOCK_FLOOR_FRACTION,
  SINCELESS_BLOCK_MS,
  SINCELESS_RETURN_MS,
  STABILITY_CALLER_READS,
  STABILITY_DEEP_TOPIC_ROWS,
  STABILITY_LONG_BLOCK_MAX_MS,
  STABILITY_LONG_BLOCK_MIN_MS,
  STABILITY_LONG_READS,
  STABILITY_READS_MAX,
  STABILITY_READS_MIN,
  STABILITY_SHORT_BLOCK_MAX_MS,
  STABILITY_SHORT_BLOCK_MIN_MS,
  STABILITY_SPAN_MS,
  STABILITY_TOPICS,
  TAIL_BLOCK_MS,
} from './budgets.js';
export { pageLimitsFor, PAGING_VOLUME } from './cases/catch-up.js';
export {
  carriesControlCharacter,
  CONTENT_SHAPES,
  isPlainAscii,
  SHORT_PAYLOAD,
} from './cases/content.js';
export {
  BURST_POSTS_MAX,
  BURST_POSTS_MIN,
  DELIVERY_MS,
  livePayload,
  LIVE_SUBSCRIPTIONS,
  liveWriter,
  QUIET_BACKLOG_ROWS,
  QUIET_DELIVERY_MS,
  QUIET_IDLE_MS,
  QUIET_POSTS,
  QUIET_POSTS_MIN,
} from './cases/live.js';
export { TOOL_BACKLOG_MIN, TOOL_PAGE } from './cases/tool-surface.js';
export { ASSERTED_PROPERTIES, CLAUSES } from './clauses.js';
export type { BackendFactory, ConformanceContext } from './factory.js';
export {
  assertConformanceContext,
  CAPABILITY_FIELDS,
  CONTEXT_FIELDS,
  openContext,
} from './factory.js';
export {
  expectPoisonCostsOneMessage,
  POISON_RECORD_CLAUSE,
  type PoisonedBatch,
} from './poison-record.js';

/**
 * The shared seam conformance suite (DESIGN §6; CLAUDE.md testing discipline). A backend conforms
 * when it holds FOUR things: a stable-unique backendMsgId; monotonic, in-order, exclusive-`since`
 * cursor delivery; a live path that delivers only a subset of the post-subscribe tail; and a live
 * path that delivers at all. The first two alone are not conformance — a plugin registering no
 * listener satisfies both and fails 10 of these cases. Write once here; run against every backend
 * via {@link BackendFactory}.
 */
export function runConformanceSuite(name: string, factory: BackendFactory): void {
  describe(`seam conformance: ${name}`, () => {
    let ctx: ConformanceContext;
    let live: ConformanceContext | undefined;
    /**
     * Assertions this case had made when it last read a capability field, or `undefined` if it read
     * none. `expect.hasAssertions()` counts the WHOLE case, so a case that asserts, then branches on
     * what the backend can represent and returns through that branch without grading anything has
     * DELETED itself for every backend on that arm while reading in the report exactly like one that
     * passed — and the whole-case count is satisfied by the assertions made before the branch.
     */
    let branchedAt: number | undefined;
    beforeEach(async () => {
      // Graded behaviourally rather than by walking the suite's own source for guard shapes: a
      // source walk is satisfied by a comment that merely mentions the read, which is how four such
      // checks in this package became decoration. This counts assertions that really ran.
      expect.hasAssertions();
      branchedAt = undefined;
      live = undefined;
      ctx = await openContext(name, factory);
      live = ctx;
    });
    afterEach(async () => {
      const done = live;
      live = undefined;
      if (branchedAt !== undefined) {
        expect(
          expect.getState().assertionCalls,
          'this case read a capability field and then finished without asserting anything after ' +
            'it. The branch it took grades nothing for every backend on that arm, and the ' +
            'whole-case assertion count cannot see it: the assertions made BEFORE the branch ' +
            'satisfy that check on their own',
        ).toBeGreaterThan(branchedAt);
      }
      await done?.cleanup();
    });
    // Keep this a VIEW rather than the context itself, so that a case cannot capture the fixture
    // that happened to be open when it was registered: registration runs once, `beforeEach` mints
    // a fresh context per case, and a captured one would be another case's backend or undefined.
    const current = new Proxy({} as ConformanceContext, {
      get: (_, field) => {
        if (CAPABILITY_FIELDS.includes(field as string)) {
          branchedAt = expect.getState().assertionCalls ?? 0;
        }
        return ctx[field as keyof ConformanceContext];
      },
    });
    catchUpCases(current);
    postCases(current);
    toolSurfaceCases(current);
    liveCases(current);
    blockingCases(current);
    concurrencyCases(current);
  });
}
