/**
 * `@sharptrick/parley-net-util/testing` — the corpora and the harness a BACKEND crosses over its own
 * `backend_config` validator. Kept off the production entry point, so that the shipped module stays
 * dependency-free and a test corpus is not a runtime import; `vitest` is an optional peer, needed
 * only by whoever imports this subpath.
 */
export {
  FORBIDDEN_IN_RENDER,
  NEVER_RENDERABLE,
  PLANTED_SECRET,
  RENDER_LEAK_SENTINEL,
  SECRET_AS_TEXT,
  UNSAFE_TEXT,
  WRAPPING_A_SECRET,
} from './hostile-config-values.js';
export {
  expectLabelledRefusal,
  type RefusalSpec,
  type UngradedKey,
} from './refusal-harness.js';
