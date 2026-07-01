# @parley/conformance

The shared seam conformance suite for [Parley](../../README.md): write the contract **once**
against `BackendPlugin`, run it against every backend plugin. Every backend in this repo
(`@parley/sqlite`, `@parley/redis`, `@parley/matrix`, `@parley/xmpp`, `@parley/nats`) is verified
by the exact same suite — this is what "adding a backend touches zero core" is checked against.

## What it proves

A backend is conformant iff:

1. every message gets a **stable, unique `backendMsgId`** (the dedup key);
2. `fetchRecent` / `subscribe` deliver **monotonic, in-order, exclusive-`since`** cursor ordering
   (the order key) — core never parses or compares cursor values, it only trusts the plugin.

Concretely, `runConformanceSuite` (`src/index.ts`) checks:

- `post` → `fetchRecent` returns messages in order, with unique ids and distinct cursors;
- catch-up since a cursor returns only strictly-newer messages (exclusive `since`);
- `since` at the tail returns empty and a stable cursor;
- the same message has an identical `backendMsgId`/`cursor` whether seen via live `subscribe` or
  via `fetchRecent` catch-up;
- topics are isolated from one another;
- (optional) concurrent multi-writer posts don't corrupt state and cursor ordering still holds.

## Using it for a new backend

Implement a `BackendFactory` (`src/factory.ts`):

```ts
import type { BackendPlugin, Topic } from '@parley/core';

export interface ConformanceContext {
  plugin: BackendPlugin;          // a freshly connected plugin instance
  freshTopic(): Topic;            // a unique, unused topic per test
  cleanup(): Promise<void>;       // disconnect + drop scratch resources
  concurrentPost?(topic: Topic, writers: number, perWriter: number): Promise<void>; // optional
}
export type BackendFactory = () => Promise<ConformanceContext>;
```

Then, in the plugin package's own test file:

```ts
import { runConformanceSuite } from '@parley/conformance';
import { asHandle, asTopic, type Topic } from '@parley/core';
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
    // concurrentPost is optional — omit if the backend can't exercise true concurrency in tests
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

`concurrentPost` is optional: implement it if the backend can genuinely exercise concurrent-write
safety in-process (SQLite forks real OS processes; the network backends open N client
connections and let each post independently). Every network backend's test file also probes for a
reachable server first and skips cleanly rather than failing when none is running — see
`packages/bridge-redis/test/conformance.test.ts` for the reference pattern.

## Tests

```bash
npx vitest run packages/conformance packages/bridge-sqlite packages/bridge-redis \
  packages/bridge-matrix packages/bridge-xmpp packages/bridge-nats
```

This package has no tests of its own — its correctness is proven by the fact that every backend
passes it. It has a `peerDependency` on `vitest` (the suite's `describe`/`it`/`expect` come from
whatever vitest the consuming package's workspace resolves).
