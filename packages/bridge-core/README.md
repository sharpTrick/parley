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

`cursor` and `backendMsgId` are opaque strings — core never parses one and never orders by one. It
does compare two for byte equality: `backendMsgId` is the dedup key, and two cursors are compared
as the no-progress brake in `catchUpTopic`. A cursor naming a position must therefore be
byte-stable across calls. `timestamp` is informational only; ordering and dedup never use it.

## What this package builds

| Piece | Export | Purpose |
|---|---|---|
| Normalized message | `Message`, `Topic`, `Handle`, `BackendMsgId`, `Cursor`, `asTopic`/`asHandle`/`asBackendMsgId`/`asCursor` | The one type crossing the seam; branded opaque ids. |
| Config | `ConfigSchema`, `parseConfig`, `loadConfig`, `instanceIdOf` | Validates `parley.config.yaml`. |
| Allowlist | `Allowlist`, `TopicNotAllowedError` | `config.topics` **is** the allowlist — no wildcard default. |
| Engine | `SeenSet`, `ReadStateStore`, `catchUpTopic` / `catchUpAll` | Dedup set, per-instance read-cursor persistence, catch-up orchestration. |
| Reactive tools | `registerTools`, `toolDepsFor` | `parley_fetch_recent` / `parley_post` / `parley_reply` / `parley_list_users` MCP tools. |
| Live push | `emitChannel`, `channelMeta`, `startPushLoop` | Emits `claude/channel` `<channel>` notifications to already-running Code sessions. |
| Local bridge | `buildBridge`, `createStdioBridge` | Composes plugin + tools + push loop into one stdio MCP server. |
| Remote bridge (v0.2) | `buildReactiveServer`, `createRemoteHttpApp`, `createOAuthRemoteApp` | Streamable-HTTP transport + single-tenant OAuth 2.1 + PKCE front door. |
| Owner auth | `ParleyOAuthProvider`, `hashOwnerSecret`, `makeOwnerVerifier`, `ownerVerifierFromPassphrase` | Owner-secret verification for remote/chat mode. |
| External-OIDC auth | `createRemoteAuthApp`, `createOidcRemoteApp`, `OidcTokenVerifier`, `fetchOidcDiscovery` | Delegated resource-server mode (RFC 9728): an external IdP (e.g. Keycloak) hosts the AS; selected via `cfg.auth.mode`. |

## Config (`parley.config.yaml`)

```yaml
# No `backend:` key — the backend is whichever parley-<name> binary you run
# (parley-sqlite here). A config carrying one is rejected at load.
instance_id: agent-main         # read-state namespace; DISTINCT per concurrent session sharing a handle
identity: { handle: "agent" }
topics: ["ctx-demo"]            # THE allowlist — no wildcard default
post_topics: ["ops-.*"]         # optional: WIDENS post/fetch to any fully-matching topic (not subscribed,
                                # but the pattern source IS published on every presence beat)
catchup: { on_start: true, limit: 100, block_max_ms: 60000, block_poll_interval_ms: 250 }
live_push: { enabled: true, mention_filter: false }
presence: { enabled: true, topic: "parley-presence", heartbeat_ms: 600000 }
backend_config:                 # opaque to core; passed verbatim to the plugin's connect()
  db_path: "./parley.db"
```

`backend_config` is the only backend-specific part of this file — see the plugin's own README for
its shape. Two concurrent sessions must never share an `instance_id` (or default handle) — each
owns its own read-state file. A clash is a PER-TOPIC race, not a lost session: every flush re-reads
the file and writes back only the topics that session advanced, so the loser re-reads or skips
messages on the contended topic only, positions on topics it advanced alone survive, and the file
is never left half-written. Cursors are backend-specific too, so an instance repointed at a
different backend needs a fresh `instance_id` (or its old read-state deleted); catch-up fails with
a message saying exactly that.

`presence.enabled` defaults to **true** and writes hello/heartbeat/goodbye to the shared
`presence.topic` on your backend — on a real Matrix or Zulip account that is a room or stream
created on first beat. Set it to `false` for reactive-only instances or where that is unwanted.
`permissions.skip_permissions` is parsed but unimplemented; setting it to `true` is a load error
rather than a silent no-op.

## MCP tools exposed

| Tool | Role | Effect |
|---|---|---|
| `parley_fetch_recent` | catch-up (reactive) | `{ topic, since?, limit?, block_ms? }` → `{ messages, nextCursor }`, plus `topicAbsent: true` when the topic does not exist on the backend yet. `block_ms` long-polls an empty window; it and `limit` are clamped server-side. Marks returned ids seen so the push loop won't re-deliver them. |
| `parley_post` | write (reactive) | `{ topic, content, in_reply_to? }` → `{ backendMsgId }`. The chat side's only write path. |
| `parley_reply` | write (channel) | `{ topic, content, in_reply_to? }` → `{ backendMsgId }`. Same durable write as `parley_post`, distinct name so Claude surfaces it as a reply to an inbound `<channel>` event. |
| `parley_list_users` | presence (reactive) | `{ filter?, topic?, online_only?, since_ms?, limit? }` → `{ users: [{ handle, online, topics, postTopics, lastSeenMs }], truncated }`. The hand-off roster, rebuilt on demand from the shared presence topic. |

Every topic argument goes through the topic `Allowlist`, which accepts a topic listed in
`config.topics` **or** one fully matching a `post_topics` pattern — so `post_topics` genuinely
widens the read/write surface beyond `topics` — and never the reserved `presence.topic`, even when
a pattern covers it. Anything else throws `TopicNotAllowedError`.

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

Alternatively, delegate authorization to an external OIDC IdP (e.g. Keycloak) and let Parley act
as a pure resource server — set `auth: { mode: oidc, oidc: { issuer, audience, ... } }` in the
config and compose with `createRemoteAuthApp(plugin, cfg, { publicUrl })` (which dispatches
between the two modes; no owner secret is needed in oidc mode). Realm setup, config reference,
and security notes: [`docs/keycloak-integration.md`](../../docs/keycloak-integration.md).

## Testing

```bash
npx vitest run packages/bridge-core
```

Covers config parsing, the allowlist, mentions, seen-set/read-state, catch-up, the reactive tools,
the channel-emit/push-loop mechanics, and the OAuth provider/remote auth flow. Backend-specific
behavior is exercised by each plugin against the shared `@sharptrick/parley-conformance` suite, not here.
