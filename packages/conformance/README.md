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

Concretely, `runConformanceSuite` (`src/index.ts`) checks:

- `post` → `fetchRecent` returns messages in order, with unique ids and distinct cursors;
- catch-up since a cursor returns only strictly-newer messages (exclusive `since`);
- paging from a cursor is lossless at every `limit`, and a `since`-less fetch returns the NEWEST
  messages (the backend's default window);
- `since` at the tail, and a never-posted topic, return empty with a **replayable** cursor;
- every delivered `Message` is well-formed: real `topic`, non-empty `senderHandle`, and `mentions`
  matching `parseMentions(content)` (core's push loop filters on it);
- the same message has an identical `backendMsgId`/`cursor` whether seen via live `subscribe` or
  via `fetchRecent` catch-up, and `subscribe` delivers exactly the post-subscribe tail, once;
- topics are isolated on **both** paths — catch-up and live push;
- `post` accepts `opts.inReplyTo` and the reply is durable, in order;
- `resolveIdentity` answers for the handle it was asked about, and distinct senders are not
  collapsed onto one another;
- `blockMs` long-poll wakes on a concurrent post and returns empty at timeout
  (`supportsBlockingFetch` backends);
- concurrent multi-writer posts don't corrupt state and cursor ordering still holds
  (`concurrentPost` backends).

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
}
export type BackendFactory = () => Promise<ConformanceContext>;
```

`runConformanceSuite` validates that shape at runtime (`assertConformanceContext`) and fails
naming the backend and the offending field: no tsconfig in this repo includes `test/**`, so a
missing field would otherwise compile fine and silently delete the cases that read it.

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

`packages/conformance/test` holds only the suite's own self-tests — that the context validator
rejects a malformed fixture. This package has a `peerDependency` on `vitest`: the suite's
`describe`/`it`/`expect` come from whatever vitest the consuming package's workspace resolves.
