# @sharptrick/parley-conformance

The shared seam conformance suite for [Parley](../../README.md): write the contract **once**
against `BackendPlugin`, run it against every backend plugin. Every backend in this repo is
verified by the exact same suite — this is what "adding a backend touches zero core" is checked
against.

## What it proves

A backend is conformant when it holds all four of these. The first two are about the message; the
last two are about the live path, and a backend that holds only the first two is **not** conformant
— measured, a plugin that registers no live listener at all satisfies (1) and (2) and fails 10 of
this suite's cases:

1. every message gets a **stable, unique `backendMsgId`** (the dedup key);
2. `fetchRecent` / `subscribe` deliver **monotonic, in-order, exclusive-`since`** cursor ordering
   (the order key) — core never parses or compares cursor values, it only trusts the plugin;
3. what `subscribe` delivers is a **subset** of the post-subscribe tail and nothing else — never
   history, never a duplicate;
4. …and it delivers: a live subscriber does not fall behind a topic written one message at a time.
   This one is graded to a stated REACH rather than in general — see `packages/bridge-core/README.md`.

Concretely, `runConformanceSuite` (`src/index.ts`) checks the clauses below. The list is not prose:
each phrase is an entry in the exported `CLAUSES` table, and this package's own tests fail if any of
them stops owning a case — a conformance clause used to be deletable with nothing going red.

- `post` → `fetchRecent` returns messages in order, with unique ids and distinct cursors;
- the same content posted twice still gets distinct ids and cursors;
- catch-up since a cursor returns only newer messages (exclusive), and since at the tail returns
  empty with a replayable cursor;
- paging from a cursor with limit is lossless at every page size;
- a since-less fetch returns the NEWEST messages — the backend's default window;
- a never-posted topic returns an empty page with a replayable cursor — or, taking the other arm
  the seam permits, rejects with `NoSuchTopicError` naming the topic (`absentTopicBehaviour`);
- core's own `parley_fetch_recent` tool, registered over this plugin,
  hands a resuming session everything it missed. Every clause above drives `plugin.fetchRecent`
  directly, which is not what an agent calls: the reconciliation the lossy-push contract rests on
  ("what push leaves out, the next `parley_fetch_recent` returns") is a property of the TOOL, and a
  session down while more than one page arrived reached only the newest page of it on five
  certified backends while this suite stayed green. Graded by running the catch-up procedure
  `docs/CONVENTIONS.md` ships — no cursor, then the `nextCursor` handed back, until a page comes
  back empty;
- every delivered `Message` is well-formed: real `topic`, non-empty `senderHandle`, and `mentions`
  matching `parseMentions(content)` (core's push loop filters on it);
- the same message has an identical `backendMsgId`/`cursor` via live push and via catch-up, and
  `subscribe` delivers only the post-subscribe tail, in cursor order, never twice. Push is
  explicitly **lossy**: what it delivers is a *subset* of that tail, and what it left out is
  returned by the next catch-up. Replaying history as if it were live is a superset, and stays
  forbidden;
- a live subscriber does not fall behind a quiet topic — the floor under the subset above. The
  subset bound is satisfied by any PREFIX of the tail, so a live path that serves the first message
  and then stops answers every other live clause here; this floor is what reaches it. What a
  delivery window cannot cover is a burst, so a topic written one message at a time, each delivered
  before the next is sent, loses nothing and is owed all of it. Held along every axis such a path can
  die along rather than at one threshold in one window: a DEPTH drawn per run from a range starting
  above the deepest any other case reaches, an AGE past the point every other case has already been
  delivered to, a BACKLOG deeper than any other case subscribes over, an independent WRITER wherever
  `concurrentPost` can supply one, and a per-message LATENCY (`QUIET_DELIVERY_MS`) well inside what
  the suite will wait. `BROKEN_VARIANTS` carries a control per axis, each at the far edge of the
  reach that run guarantees — the same doctrine the blocking clause's switch table applies, because
  a floor at one named figure is one a plugin can read off this package and cap itself at;
- `subscribe` delivers a message **written by an independent client** — not only the subscriber's
  own writes. This is the case Parley exists for (a human posts in chat, an agent must receive it),
  and a plugin whose live path registers no server-side listener and merely echoes its own `post`
  used to pass in full. Graded through `concurrentPost`, so it skips only where the backend cannot
  represent a second writer at all — and on that arm (`'unsupported'`, which today is Telegram
  alone) NOTHING in this suite can see a loopback: the floor above then has no writer but the
  subscriber either, so what certifies a live path there is that it delivers, not who wrote it;
- topics are isolated on catch-up, and on the live path too;
- disconnect is idempotent and stops the plugin serving;
- post either round-trips a payload exactly — newline, surrounding spaces, an astral emoji, a
  combining sequence, a tab — or refuses it, never altering it silently, and WHICH of the two is
  the fixture's declaration (`refusesContentShapes`) rather than its choice per run: a refusal is
  also a shape the live floor cannot carry, so a declared refusal must be real and an undeclared one
  is a failure. Carriage return is not yet a
  row, and not because it cannot be graded: XMPP carries bodies as XML character data, where the
  parser normalizes CR to LF (XML 1.0 §2.11) before any plugin sees it, so the wire genuinely
  cannot round-trip one — but *refusing* it is the other arm this clause already permits, and
  `bridge-xmpp` today accepts a CR and stores an LF, which is exactly the silent alteration the
  clause forbids. The row lands once that plugin refuses instead;
- post accepts inReplyTo and the reply is durable, in order;
- resolveIdentity answers for the handle it was asked about;
- distinct senders are not collapsed onto one another;
- blockMs is honoured natively or refused — never silently ignored, never a hang. A backend that
  parks wakes on a concurrent post and returns empty *at* the timeout, having actually waited
  (`IDLE_BLOCK_FLOOR_MS`), since a native block that answers "still nothing" at once is a long-poll
  core turns into a hot loop. A backend with no read primitive to park on rejects with
  `BlockingFetchUnsupportedError` instead — promptly (`REFUSAL_RETURN_MS`), and for every budget it
  is handed, because a refusal followed by a page is what a long-poll that timed out empty looks
  like. Which arm a backend is on is decided by what it DOES with a budget, never by a declaration:
  a plugin that answers a budget with the window it already had is graded on the arm that required
  it to wait. A since-LESS read carrying a block budget must come back in a FRACTION of it
  (`SINCELESS_RETURN_MS`), not merely inside it: that is the hot path for every
  `parley_fetch_recent` an agent makes before it holds a cursor, and a bound set at the budget
  itself certifies a plugin that parks for all of it;
- a post landing in the window between a blocking fetch issuing its read and registering its
  waiter is not missed — a blocking fetch is not missed by 0-3ms of race;
- the same arm answers a long run of unpredictable budgets: a drawn number of blocking reads over
  drawn budgets — including budgets the size an agent really sends, up to what `catchup.block_max_ms`
  allows — spread over several topics, one of them deep, and over seconds of ONE connection. Every
  read the suite makes is scored, across cases and across connections: a backend that answers
  `block_ms` one way on this connection and another on the next has changed the contract under a
  caller who cannot see connections at all. Every SERVED read that comes back empty must have spent
  its budget, so a backend that stays nominally on the serving arm while silently dropping the budget
  is graded on the arm it claims. A finite run cannot catch a switch at an arbitrary threshold: what
  is held is the class up to this run's reach, and `BROKEN_VARIANTS` carries a control at the far
  edge of each axis it reaches along;
- a backend that declares `carriesSenderIdentity: false` still reports ONE stable, non-empty
  `senderHandle` and keeps the two posts distinguishable by id;
- multi-process writes don't corrupt state and cursor ordering still holds, and a reader
  interleaved with concurrent writers loses no message — the shape that catches a cursor minted
  from a pre-commit sequence (`concurrentPost` backends).

## Using it for a new backend

Implement a `BackendFactory` (`src/factory.ts`). **Every field is required** — including the
capability flags, which take an explicit negative rather than being omitted, because an optional
flag whose absent value means "skip" silently trades coverage for convenience:

```ts
import type { BackendPlugin, Topic } from '@sharptrick/parley-core';

export interface ConformanceContext {
  /** A freshly connected plugin instance. */
  plugin: BackendPlugin;
  /** A unique, unused topic — isolates each test from the others. */
  freshTopic(): Topic;
  /** Disconnect + remove any scratch resources. */
  cleanup(): Promise<void>;
  /**
   * Drive `writers` independent concurrent writers, each posting `perWriter` messages, or the
   * literal `'unsupported'` when the backend cannot represent concurrent writers at all
   * (Telegram allows one `getUpdates` consumer per token; a second poller gets HTTP 409).
   */
  concurrentPost:
    | ((topic: Topic, writers: number, perWriter: number) => Promise<void>)
    | 'unsupported';
  /**
   * True when the backend round-trips `post`'s `identity` as the message's `senderHandle`. False
   * for backends that stamp the authenticated account instead (every hosted SaaS posts as its bot
   * user; Matrix reports the homeserver-stamped `sender`) — there, asserting it would assert a lie.
   */
  carriesSenderIdentity: boolean;
  /**
   * Labels from `CONTENT_SHAPES` this backend REFUSES on `post`. Every backend here states `[]`
   * but Zulip, whose server strips trailing whitespace on send.
   * A declared refusal must be real (the write clause asserts the rejection) and withdraws that
   * shape from the live floor, which records what it carried against what was declared — so a
   * refusal is an arm taken in the open, never a silent fallback.
   */
  refusesContentShapes: readonly string[];
  /**
   * Which arm of `fetchRecent`'s absent-topic contract this backend takes: an empty page with a
   * replayable cursor, or a `NoSuchTopicError` rejection — seam.ts permits both. The ONLY optional
   * field, and only because its default (`'empty-page'`) is the stricter arm, so omitting it
   * cannot buy a weaker grade.
   */
  absentTopicBehaviour?: 'empty-page' | 'throws';
}
export type BackendFactory = () => Promise<ConformanceContext>;
```

`runConformanceSuite` validates that shape at runtime (`assertConformanceContext`) and fails
naming the backend and the offending field. That runtime check is what enforces "required", and no
amount of typechecking retires it: the fixture crosses a published package boundary, so the suite
receives whatever the factory actually returns rather than what its declared return type promises.
A consumer written in JavaScript has no compiler at all; one that builds its context from config, or
reaches its plugin through a cast, has a compiler that cannot see the value. A field missing at that
point does not lose a build — it silently deletes the cases that read it, and the backend is
certified on the strength of a suite that never ran them.

Then, in the plugin package's own test file:

```ts
import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, it } from 'vitest';
import { MyBackendPlugin } from '../src/index.js';

let seq = 0;

async function makeContext() {
  const plugin = new MyBackendPlugin();
  await plugin.connect({ /* backend_config */ });
  return {
    plugin,
    freshTopic: (): Topic => asTopic(`t-${++seq}-${Math.random().toString(36).slice(2, 8)}`),
    cleanup: () => plugin.disconnect(),
    concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
      /* open N independent clients and let each post `perWriter` messages */
    },
    carriesSenderIdentity: false,
  };
}

if (await isBackendReachable()) {
  runConformanceSuite('my-backend', makeContext);
} else {
  describe.skip('seam conformance: my-backend (no server reachable)', () => {
    it('skipped — start the dev server to run', () => undefined);
  });
}
```

Every network backend's test file probes for a reachable server first and skips cleanly rather
than failing when none is running — see `packages/bridge-redis/test/conformance.test.ts` for the
reference pattern.

## Tests

The suite's real proof is every backend passing it:

```bash
npx vitest run packages/conformance packages/bridge-sqlite packages/bridge-redis \
  packages/bridge-nats packages/bridge-postgres packages/bridge-matrix packages/bridge-xmpp \
  packages/bridge-zulip packages/bridge-slack packages/bridge-discord packages/bridge-telegram
```

`packages/conformance/test` also holds the suite's CONTROLS, which need no server and so run
everywhere:

- `reference.test.ts` runs the whole suite against an in-memory `ReferencePlugin` that is
  conformant by construction (both arms of the absent-topic contract). It must pass.
- `negative-control.test.ts` runs the suite against `BROKEN_VARIANTS` — one deliberately
  non-conformant plugin per way a backend can be wrong — and requires each one to FAIL the case built
  to catch it. **Every clause in `CLAUSES` must own such a variant**, asserted mechanically rather
  than kept in step by hand: seven clauses once had no control at all, so their assertions could be
  gutted with this whole package staying green while every backend kept being certified against the
  weakened clause. Vitest cannot invert a suite's result in-process, so that run happens in a child
  process behind `PARLEY_CONFORMANCE_BROKEN=1` and this test grades its JSON report.

Plus the self-tests: that the context validator rejects a malformed fixture, that every clause in
`CLAUSES` still owns a case, and that no case buys itself out of asserting on a capability flag.
This package has a `peerDependency` on `vitest`: the suite's `describe`/`it`/`expect` come from
whatever vitest the consuming package's workspace resolves.
