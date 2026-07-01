# @sharptrick/parley-core

The transport-agnostic seam: normalized `Message`, cursor/dedup engine, config schema, topic
allowlist, and the dual-role MCP server (reactive tools + live `claude/channel` push). **Zero
backend dependencies** — plugins depend on this package, never the reverse (`CLAUDE.md` prime
directive #1).

This package is a library, not something you run directly. Install a backend plugin
(`@sharptrick/parley-sqlite`, `@sharptrick/parley-redis`, `@sharptrick/parley-matrix`, `@sharptrick/parley-xmpp`, `@sharptrick/parley-nats`) and build a
bridge with the exports below — see the [root README](../../README.md) for the end-to-end
quickstart.

## The seam

```ts
interface BackendPlugin {
  connect(config: BackendConfig): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(topic: Topic, handler: MessageHandler): Promise<void>;                 // live path (push)
  post(topic: Topic, identity: Handle, content: string, opts?: { inReplyTo?: BackendMsgId }): Promise<BackendMsgId>;
  fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult>;                  // catch-up
  resolveIdentity(handle: Handle): Promise<BackendIdentity>;
}
```

A conforming backend guarantees two things (checked by `@sharptrick/parley-conformance`):

1. a **stable, unique `backendMsgId`** per message — the dedup key;
2. **monotonic, in-order, exclusive-`since` cursor delivery** — `fetchRecent` returns messages
   pre-sorted ascending and `subscribe`'s handler fires in ascending order per topic.

`cursor` and `backendMsgId` are opaque strings — core never parses or compares them. `timestamp`
is informational only; ordering and dedup never use it.

## What this package builds

| Piece | Export | Purpose |
|---|---|---|
| Normalized message | `Message`, `Topic`, `Handle`, `BackendMsgId`, `Cursor`, `asTopic`/`asHandle`/`asBackendMsgId`/`asCursor` | The one type crossing the seam; branded opaque ids. |
| Config | `ConfigSchema`, `parseConfig`, `loadConfig`, `instanceIdOf` | Validates `parley.config.yaml`. |
| Allowlist | `Allowlist`, `TopicNotAllowedError` | `config.topics` **is** the allowlist — no wildcard default. |
| Engine | `SeenSet`, `ReadStateStore`, `catchUpTopic` / `catchUpAll` | Dedup set, per-instance read-cursor persistence, catch-up orchestration. |
| Reactive tools | `registerTools`, `buildToolDefs` | `parley_fetch_recent` / `parley_post` / `parley_reply` MCP tools. |
| Live push | `emitChannel`, `channelMeta`, `startPushLoop` | Emits `claude/channel` `<channel>` notifications to already-running Code sessions. |
| Local bridge | `buildBridge`, `createStdioBridge` | Composes plugin + tools + push loop into one stdio MCP server. |
| Remote bridge (v0.2) | `buildReactiveServer`, `createRemoteHttpApp`, `createOAuthRemoteApp` | Streamable-HTTP transport + single-tenant OAuth 2.1 + PKCE front door. |
| Owner auth | `ParleyOAuthProvider`, `hashOwnerSecret`, `makeOwnerVerifier`, `ownerVerifierFromPassphrase` | Owner-secret verification for remote/chat mode. |

## Config (`parley.config.yaml`)

```yaml
backend: local-sqlite          # which plugin to load
instance_id: agent-main        # read-state namespace; DISTINCT per concurrent session sharing a handle
identity: { handle: "agent" }
topics: ["ctx-demo"]            # THE allowlist — no wildcard default
catchup: { on_start: true, limit: 100 }
live_push: { enabled: true, mention_filter: false }
permissions: { skip_permissions: false }   # sandbox-only; default OFF, never flip on as convenience
backend_config:                 # opaque to core; passed verbatim to the plugin's connect()
  db_path: "./parley.db"
```

`backend_config` is the only backend-specific part of this file — see the plugin's own README for
its shape. Two concurrent sessions must never share an `instance_id` (or default handle) — each
owns its own read-state file, and a clash silently clobbers the other's catch-up position.

## MCP tools exposed

| Tool | Role | Effect |
|---|---|---|
| `parley_fetch_recent` | catch-up (reactive) | `{ topic, since?, limit? }` → `{ messages, nextCursor }`. Marks returned ids seen so the push loop won't re-deliver them. |
| `parley_post` | write (reactive) | `{ topic, content, in_reply_to? }` → `{ backendMsgId }`. The chat side's only write path. |
| `parley_reply` | write (channel) | Same durable write as `parley_post`, distinct name so Claude surfaces it as a reply to an inbound `<channel>` event. |

All three go through the topic `Allowlist` — any topic outside `config.topics` throws
`TopicNotAllowedError`.

## Local (stdio) bridge

```ts
import { createStdioBridge, loadConfig } from '@sharptrick/parley-core';
import { SqlitePlugin } from '@sharptrick/parley-sqlite';

const cfg = loadConfig('parley.config.yaml');
const bridge = await createStdioBridge(new SqlitePlugin(), cfg);
// ... on shutdown: await bridge.shutdown();
```

This is what each plugin's `cli.ts` wraps (see `@sharptrick/parley-sqlite`'s `parley-sqlite` bin). Point a
`.mcp.json` server entry at the built CLI and launch with
`claude --dangerously-load-development-channels --channels server:parley` — see the
[root README](../../README.md) and
[`examples/fakechat-loopback`](../../examples/fakechat-loopback/MANUAL-CHECKLIST.md) for the full
channel walkthrough.

## Remote / chat (OAuth) mode

```ts
import { createOAuthRemoteApp, ownerVerifierFromPassphrase } from '@sharptrick/parley-core';
// plugin.connect(...) once, then:
const app = createOAuthRemoteApp(plugin, cfg, {
  issuerUrl: new URL('https://parley.example.com'),
  verifyOwner: ownerVerifierFromPassphrase(process.env.PARLEY_OWNER_PASSPHRASE!),
});
await app.listen(3000);
```

Single-tenant: the instance authenticates exactly one owner; backend credentials never leave the
server, and Claude only ever holds a consented, audience-bound token. Full deployment guide
(HTTPS, the public-exposure constraint, and Anthropic IP-range allowlisting) is in
[`examples/self-host-remote`](../../examples/self-host-remote/README.md).

## Testing

```bash
npx vitest run packages/bridge-core
```

Covers config parsing, the allowlist, mentions, seen-set/read-state, catch-up, the reactive tools,
the channel-emit/push-loop mechanics, and the OAuth provider/remote auth flow. Backend-specific
behavior is exercised by each plugin against the shared `@sharptrick/parley-conformance` suite, not here.
