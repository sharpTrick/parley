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
  'hands a resuming session everything it missed',
  'via live push and via catch-up',
  'either round-trips',
  'post accepts inReplyTo',
  'only the post-subscribe tail',
  'does not fall behind a quiet topic',
  'written by an independent client',
  'topics are isolated',
  'on the live path too',
  'disconnect is idempotent',
  'resolveIdentity answers',
  'not collapsed onto one another',
  'blockMs is honoured natively or refused',
  'blocking fetch is not missed',
  'a long run of unpredictable budgets',
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
 * - `interleaved-reader-sees-each-row-once-in-order`: a reader paging a topic WHILE it is being
 *   written sees every row exactly once, in cursor order. Neither the field registry nor the clause
 *   registry can require a control for it: the clause's own control fails through the assertion
 *   BESIDE it (a row the reader never saw at all), so the re-delivery and re-ordering half could be
 *   deleted with this package — negative control included — staying green.
 *
 * - `blocking-arm-is-stable`: the answer a backend gives a block budget does not CHANGE. The arm is
 *   inferred from behaviour rather than declared, so a plugin that refuses exactly the reads the
 *   suite is known to make and silently drops every budget after them takes the refusing arm and
 *   ignores every `block_ms` a real agent sends. Graded over every blocking read the suite makes,
 *   across cases and across connections, since a caller sees neither.
 *
 *   A finite run cannot catch a switch at an arbitrary threshold, so what is held is the class up to
 *   the long run's REACH: the number of budgets it hands out, how large they are — up to what a
 *   caller may legally send, not merely what is convenient to wait out — the topics it names and how
 *   deep they are, the connections it opens, and the wall clock it covers. `BROKEN_VARIANTS` carries
 *   one control per axis, each sitting at the far edge of that reach, so a reach that shrinks stops
 *   failing a control instead of silently narrowing what the clause means.
 * - `caller-scale-block-is-answered`: a budget the size an agent really sends is answered, not
 *   parked on. Every other budget here is small enough for the suite to sit through, which is itself
 *   a fingerprint — a plugin that honours small figures and drops large ones passes a run drawn only
 *   from small ones.
 * - `refusing-read-covers-only-what-it-returned`: on the arm that never parks, a durable read
 *   racing a write reports a cursor no higher than the last row it RETURNED. Reporting the topic's
 *   tail instead — a cursor minted after the read rather than from its own rows — covers a message
 *   the caller never saw, and resuming from it skips that message for good. This is the lost-wakeup
 *   hazard as the eight refusing backends meet it, and only a control that REFUSES `blockMs` can
 *   reach the branch that asserts it.
 * - `refusal-is-not-an-empty-page`: a backend that refuses one block budget refuses every one of
 *   them. A refusal followed by a page is indistinguishable, to the caller, from a long-poll that
 *   timed out empty — so the agent goes on polling in the belief that it is parked.
 * - `content-shape-declaration`: which of `post`'s two permitted answers a backend gives each
 *   `CONTENT_SHAPES` row is its DECLARATION (`refusesContentShapes`), not its choice per run — and
 *   the declaration binds BOTH paths: a declared refusal must really be refused, an undeclared one
 *   is a failure, and a declared refusal withdraws that shape from the live floor. It is neither a
 *   Message field nor a seam call, and the capability-arm table cannot name its arms (they are a
 *   LIST), so without an entry here nothing would require a control. While the arm was implicit —
 *   `post` free to refuse silently, the floor falling back to a bare token on a rejection — a
 *   backend that refused every shape AND dropped every long, non-ASCII or control-carrying message
 *   live was certified 36 of 36: the identical measurement recorded for the defect the shared
 *   content table was added to catch.
 *
 * The three below are ELAPSED TIME, which is neither a field nor a call. Every assertion over
 * `Date.now() - <start>` names one of them in its own failure message, and `suite-shape` requires
 * that of any new one — an uncontrolled timing bound is invisible to every other check here.
 *
 * - `sinceless-block-returns-promptly`: a read carrying a block budget and NO cursor answers at
 *   once — with the window it already had, or with a refusal. That is the first iteration of core's
 *   long-poll wrapper, i.e. every `parley_fetch_recent` an agent makes before it holds a cursor.
 * - `refusal-is-prompt`: a backend that cannot serve a budget refuses it AT ONCE. One that parks
 *   first and refuses afterwards has spent the caller's wait and returned nothing for it.
 * - `native-block-wakes-on-the-message`: a native blocker returns when the message lands, not when
 *   the budget expires.
 * - `native-block-actually-waits`: and it waits for it — a native `blockMs` that returns instantly
 *   with nothing to report turns core's long-poll into a hot loop against the backend.
 * - `native-block-waits-every-time`: EVERY read on the serving arm that comes back empty spent its
 *   budget, not just the one the idle clause measures by hand. A backend that honours the first few
 *   budgets on a connection and answers instantly forever after never leaves the serving arm, so
 *   nothing that grades the arm alone can see it — and one hand-measured read is by construction one
 *   of the first few.
 * - `live-delivery-is-prompt`: a message reaches a live handler inside a bound well under what the
 *   suite will WAIT for one. Core holds nothing open for a `<channel>` event, so a delivery seconds
 *   late is one the agent acts on after the turn it belonged to — and every other clause on the live
 *   path is satisfied by a path that delivers everything, eventually.
 * - `native-block-does-not-overshoot-the-budget`: and not far PAST it. Core holds the caller's
 *   request open for whatever the plugin spends, so a blocker that answers a 300 ms budget after
 *   3 s is a hang under a politer name — and every floor in the clause passes for one, leaving only
 *   the harness timeout, which names no clause at all.
 */
export const ASSERTED_PROPERTIES: readonly string[] = [
  'nextCursor-agreement',
  'nextCursor-stability',
  'limit-honoured',
  'disconnect-stops-live-delivery',
  'post-id-agreement',
  'interleaved-reader-sees-each-row-once-in-order',
  'blocking-arm-is-stable',
  'caller-scale-block-is-answered',
  'refusing-read-covers-only-what-it-returned',
  'refusal-is-not-an-empty-page',
  'content-shape-declaration',
  'sinceless-block-returns-promptly',
  'refusal-is-prompt',
  'native-block-wakes-on-the-message',
  'native-block-actually-waits',
  'native-block-waits-every-time',
  'native-block-does-not-overshoot-the-budget',
  'live-delivery-is-prompt',
];
