/**
 * `@sharptrick/parley-core/testing` — the fixtures a CONSUMER of this package needs to grade its own
 * plugin, kept off the production entry point.
 *
 * They are shipped, not internal: the conformance suite runs out of this repo against a backend
 * nobody here wrote, and its handler-fault clause has to drive the same table core grades itself
 * against, so one row added here reaches every backend rather than each one restating a list that
 * drifts. But a TEST table on the production barrel is a semver commitment of the worst kind —
 * `FailureShape` is a union that grows, a consumer writing `Record<FailureShape, X>` breaks on the
 * next row, and under this repo's release process a merge to `main` publishes and `feat:` is a
 * minor. Behind a subpath the same growth is a change to a surface only test code imports.
 */
export {
  FAILURE_SHAPE_NAMES,
  FAILURE_SHAPES,
  type FailureShape,
  unhandledDuring,
} from './failure-shapes.js';
export { startFakeOidc, type FakeOidc, type FakeOidcClaims } from './fake-oidc.js';
