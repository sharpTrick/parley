/**
 * Every clause this suite grades, as a phrase that must appear in the title of a case it registers.
 *
 * This table is what makes deleting or renaming a clause a failure in THIS package: without it a
 * clause could go, with the README still advertising it and every backend still certified against
 * the weakened suite. Adding a case means adding its clause here.
 */
export const CLAUSES: readonly string[] = [
  'in order, with unique ids and distinct cursors',
  'the same content posted twice',
  'only newer messages (exclusive)',
  'paging from a cursor with limit',
  'returns the NEWEST messages',
  'since at the tail',
  'never-posted topic',
  'via live push and via catch-up',
  'either round-trips',
  'post accepts inReplyTo',
  'exactly the post-subscribe tail',
  'written by an independent client',
  'topics are isolated',
  'on the live path too',
  'disconnect is idempotent',
  'resolveIdentity answers',
  'not collapsed onto one another',
  'blockMs is honoured natively or ignored promptly',
  'blocking fetch is not missed',
  'interleaved with concurrent writers',
  'multi-process writes',
];

/**
 * What the suite asserts that is neither a `Message` FIELD nor a seam CALL. The clause↔variant and
 * field↔variant mappings both stop above these, so each term owns a `BROKEN_VARIANTS` entry — else
 * its assertions can all be deleted with this package, negative control included, staying green.
 *
 * - `nextCursor-agreement`: a page's `nextCursor` is the cursor of the last row IT returned, never
 *   the topic's tail — reporting the tail on a truncated page drops everything in between.
 * - `nextCursor-stability`: an empty page's cursor does not move, so a drained catch-up loop stays
 *   drained instead of re-reading the window forever.
 * - `limit-honoured`: a page never carries more rows than `limit`.
 * - `disconnect-stops-live-delivery`: nothing reaches a handler after `disconnect()` — the loop or
 *   socket that goes round once more decides whether core keeps emitting `<channel>` events for a
 *   backend it believes is gone, and whether the MCP process can exit.
 * - `post-id-agreement`: the id `post` RETURNS is the id the read paths report for that message.
 *   Core stores what `post` returned as the dedup key without reading it back, so a plugin that
 *   spells the two differently — a composite key built one way on the write path and another on the
 *   read path — re-delivers its own messages on every catch-up. The uniqueness assertions cannot see
 *   it: a re-spelled id is still unique and still stable.
 *
 * The four below are ELAPSED TIME, which is neither a field nor a call. Every assertion over
 * `Date.now() - <start>` names one of them in its own failure message, and `suite-shape` requires
 * that of any new one — an uncontrolled timing bound is invisible to every other check here.
 *
 * - `sinceless-block-returns-promptly`: a read carrying a block budget and NO cursor returns its
 *   default window at once. That is the first iteration of core's long-poll wrapper, i.e. every
 *   `parley_fetch_recent` an agent makes before it holds a cursor.
 * - `ignored-block-returns-promptly`: a backend that declares no native support ignores `blockMs`
 *   promptly rather than parking on it. The hint is optional; hanging on it is not.
 * - `native-block-wakes-on-the-message`: a native blocker returns when the message lands, not when
 *   the budget expires.
 * - `native-block-actually-waits`: and it waits for it — a native `blockMs` that returns instantly
 *   with nothing to report turns core's long-poll into a hot loop against the backend.
 */
export const ASSERTED_PROPERTIES: readonly string[] = [
  'nextCursor-agreement',
  'nextCursor-stability',
  'limit-honoured',
  'disconnect-stops-live-delivery',
  'post-id-agreement',
  'sinceless-block-returns-promptly',
  'ignored-block-returns-promptly',
  'native-block-wakes-on-the-message',
  'native-block-actually-waits',
];
