# @sharptrick/parley-conformance

The shared seam conformance suite for [Parley](../../README.md): write the contract **once**
against `BackendPlugin`, run it against every backend plugin. Every backend in this repo is
verified by the exact same suite — this is what "adding a backend touches zero core" is checked
against.

## What it proves

A backend is conformant iff:

1. every message gets a **stable, unique `backendMsgId`** (the dedup key);
2. `fetchRecent` / `subscribe` deliver **monotonic, in-order, exclusive-`since`** cursor ordering
   (the order key) — core never parses or compares cursor values, it only trusts the plugin.

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
- every delivered `Message` is well-formed: real `topic`, non-empty `senderHandle`, and `mentions`
  matching `parseMentions(content)` (core's push loop filters on it);
- the same message has an identical `backendMsgId`/`cursor` via live push and via catch-up, and
  `subscribe` delivers exactly the post-subscribe tail, once, in cursor order;
- `subscribe` delivers a message **written by an independent client** — not only the subscriber's
  own writes. This is the case Parley exists for (a human posts in chat, an agent must receive it),
  and a plugin whose live path registers no server-side listener and merely echoes its own `post`
  used to pass in full. Graded through `concurrentPost`, so it skips only where the backend cannot
  represent a second writer at all;
- topics are isolated on catch-up, and on the live path too;
- disconnect is idempotent and stops the plugin serving;
- post either round-trips a payload exactly — newline, surrounding spaces, an astral emoji, a
  combining sequence, a tab — or refuses it, never altering it silently. Carriage return is not yet a
  row, and not because it cannot be graded: XMPP carries bodies as XML character data, where the
  parser normalizes CR to LF (XML 1.0 §2.11) before any plugin sees it, so the wire genuinely
  cannot round-trip one — but *refusing* it is the other arm this clause already permits, and
  `bridge-xmpp` today accepts a CR and stores an LF, which is exactly the silent alteration the
  clause forbids. The row lands once that plugin refuses instead;
- post accepts inReplyTo and the reply is durable, in order;
- resolveIdentity answers for the handle it was asked about;
- distinct senders are not collapsed onto one another;
- blockMs is honoured natively or ignored promptly — never a hang: it wakes on a concurrent post
  and returns empty at timeout on a `supportsBlockingFetch` backend — *at* the timeout, having
  actually waited (`IDLE_BLOCK_FLOOR_MS`), since a native block that answers "still nothing" at once
  is a long-poll core turns into a hot loop — and returns promptly and empty on one that declares it
  `false`. The hint is optional; hanging on it is not. A since-LESS read
  carrying a block budget must come back in a FRACTION of it (`SINCELESS_RETURN_MS`), not merely
  inside it: that is the hot path for every `parley_fetch_recent` an agent makes before it holds a
  cursor, and a bound set at the budget itself certifies a plugin that parks for all of it;
- a post landing in the window between a blocking fetch issuing its read and registering its
  waiter is not missed — a blocking fetch is not missed by 0-3ms of race;
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
   * True when the plugin honors `blockMs` NATIVELY in `fetchRecent` (Redis `XREAD BLOCK`, NATS
   * pull expiry, Matrix `/sync` timeout, Postgres `LISTEN`/`NOTIFY`, …). False when it gets its
   * long-poll from core's generic wrapper instead — SQLite.
   */
  supportsBlockingFetch: boolean;
  /**
   * True when the backend round-trips `post`'s `identity` as the message's `senderHandle`. False
   * for backends that stamp the authenticated account instead (every hosted SaaS posts as its bot
   * user; Matrix reports the homeserver-stamped `sender`) — there, asserting it would assert a lie.
   */
  carriesSenderIdentity: boolean;
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
    supportsBlockingFetch: true,
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
