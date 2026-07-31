import { afterEach, beforeEach, describe } from 'vitest';
import { blockingCases } from './cases/blocking.js';
import { catchUpCases } from './cases/catch-up.js';
import { concurrencyCases } from './cases/concurrency.js';
import { liveCases } from './cases/live.js';
import { postCases } from './cases/post.js';
import { type BackendFactory, type ConformanceContext, openContext } from './factory.js';

export {
  EARLY_RETURN_FRACTION,
  IDLE_BLOCK_FLOOR_MS,
  IDLE_BLOCK_MS,
  PARK_FRACTION,
  SINCELESS_BLOCK_MS,
  SINCELESS_RETURN_MS,
} from './budgets.js';
export { pageLimitsFor, PAGING_VOLUME } from './cases/catch-up.js';
export { ASSERTED_PROPERTIES, CLAUSES } from './clauses.js';
export type { BackendFactory, ConformanceContext } from './factory.js';
export { assertConformanceContext, CONTEXT_FIELDS, openContext } from './factory.js';

/**
 * The shared seam conformance suite (DESIGN §6; CLAUDE.md testing discipline). A backend
 * conforms iff: stable-unique backendMsgId AND monotonic, in-order, exclusive-`since` cursor
 * delivery. Write once here; run against every backend via {@link BackendFactory}.
 */
export function runConformanceSuite(name: string, factory: BackendFactory): void {
  describe(`seam conformance: ${name}`, () => {
    let ctx: ConformanceContext;
    let live: ConformanceContext | undefined;
    beforeEach(async () => {
      live = undefined;
      ctx = await openContext(name, factory);
      live = ctx;
    });
    afterEach(async () => {
      const done = live;
      live = undefined;
      await done?.cleanup();
    });
    // Keep this a VIEW rather than the context itself, so that a case cannot capture the fixture
    // that happened to be open when it was registered: registration runs once, `beforeEach` mints
    // a fresh context per case, and a captured one would be another case's backend or undefined.
    const current = new Proxy({} as ConformanceContext, {
      get: (_, field) => ctx[field as keyof ConformanceContext],
    });
    catchUpCases(current);
    postCases(current);
    liveCases(current);
    blockingCases(current);
    concurrencyCases(current);
  });
}
