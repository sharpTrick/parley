/**
 * `@sharptrick/parley-net-util/testing` — the shared instruments a guard is built out of: the
 * hostile-value corpora and the refusal harness a BACKEND crosses over its own `backend_config`
 * validator, plus the workspace walker, the import-graph reader, the comment stripper and the
 * derived-table ruler that every repo-wide rule reads the tree through.
 *
 * Kept off the production entry point, so that the shipped module stays dependency-free and a test
 * corpus is not a runtime import; `vitest` is an optional peer, needed only by whoever imports this
 * subpath — `derivedRows` registers a case of its own, so it cannot be pure.
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
  importedNames,
  importsIn,
  exportedNames,
  consumersOf,
} from './imports.js';
export {
  codeOf,
  commentaryLines,
  withoutComments,
} from './source-text.js';
export {
  backendPackages,
  filesUnder,
  type Manifest,
  SUITE,
  workspaceAreas,
  workspacePackages,
  workspaceRoot,
} from './workspace.js';
export {
  type Derivation,
  derivationFaults,
  derivedRows,
  rowText,
} from './derived-rows.js';
export {
  expectLabelledRefusal,
  type RefusalSpec,
} from './refusal-harness.js';
