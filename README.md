# Parley

[![CI](https://github.com/sharpTrick/parley/actions/workflows/ci.yml/badge.svg)](https://github.com/sharpTrick/parley/actions/workflows/ci.yml)

> Parley — a transport-agnostic MCP seam for messages, context sharing, and task hand-off
> between humans, chat bots, and coding agents. One pluggable interface; runs on local SQLite,
> Redis, Matrix, or NATS. Bridges Claude chat ↔ Claude Code via native channels.

A *parley* is a conference between parties to reach understanding. Parley (the tool) lets humans,
Claude chat, and Claude Code confer on common ground: context explored in one place (say, a Claude
chat session) can be handed off and acted on by a Claude Code session — or watched and joined by a
human in a normal chat client — over whichever backend you choose.

The bet: the hard, platform-independent half (push delivery, catch-up, routing, dedup) is written
**once**, above a small seam. Each backend is a thin plugin implementing **five methods**.

> **Status: v1 — all five backends done and verified. 97 tests green.**
> - **v0.1** local SQLite (stdio, catch-up + polling push + reply), the shared conformance suite,
>   and a headless channel loopback. **v0.2** remote / chat mode: a Streamable-HTTP transport +
>   single-tenant **OAuth 2.1 + PKCE** front door, verified end-to-end as a Claude connector drives
>   it (discovery → DCR → PKCE → owner consent → token → MCP).
> - **v0.3 Redis** (event-driven, `XREAD BLOCK`), **v0.4 Matrix** (Synapse, C-S API), **v0.5 NATS**
>   (JetStream) **and XMPP** (Prosody, MAM) — each verified against a live server by the **same**
>   shared conformance suite.
> - **The seam held:** adding every backend after the first touched **zero** `@parley/core` code
>   (`git diff` confirms it). One interface, five transports, one suite.

## How it works

```
 Messaging backend (SQLite | Redis | Matrix | XMPP | NATS)   topics · handles · history
        │  backend-native protocol
 Backend plugin  ── implements the SEAM: connect · disconnect · subscribe · post · fetchRecent · resolveIdentity
        │  normalized Message (topic, sender, content, backendMsgId, cursor, mentions)
 @parley/core    ── reactive tools (post + fetchRecent)  ·  proactive push (<channel> events)
        │             dedup + ordering via cursor · reply fan-out · topic allowlist
   ┌────┴─────────────────────────┐
 Claude Code                    Claude chat / human in a chat client
 post + fetchRecent + subscribe   post + fetchRecent
```

- **Two delivery paths by design.** *Live push* uses Claude Code's native `claude/channel`
  capability — it reaches already-running sessions only and keeps no history. *Catch-up* uses
  standard MCP tools backed by the backend's own persistence — the durable path. **The backend is
  the source of truth.**
- **Ordering & dedup never use timestamps.** Every backend exposes a monotonic per-topic `cursor`
  and a stable `backendMsgId`; core dedups on the id and trusts the plugin's cursor order. A
  dropped push is harmless — the cursor reconciles it via `fetchRecent`.
- **The seam is the product.** Adding a backend touches *only* the new plugin — never
  `@parley/core`. A shared conformance suite runs against every backend.

## The seam

```ts
interface BackendPlugin {
  connect(config): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(topic, handler): Promise<void>;                 // live path (push)
  post(topic, identity, content, opts?): Promise<BackendMsgId>; // single durable write path
  fetchRecent({ topic, since?, limit? }): Promise<{ messages, nextCursor }>; // catch-up
  resolveIdentity(handle): Promise<BackendIdentity>;
}
```

## Quickstart (v0.1, local SQLite + Claude Code)

```bash
npm install
npm run build
npm test          # full suite incl. conformance + headless channel loopback
```

Write a config (`parley.config.yaml`):

```yaml
backend: local-sqlite
identity: { handle: "agent" }
topics: ["ctx-demo"]
catchup: { on_start: true, limit: 100 }
live_push: { enabled: true, mention_filter: false }
backend_config:
  db_path: "./parley-demo.db"
  poll_interval_ms: 500
```

Parley is an MCP **stdio server that declares `claude/channel`**, so Claude Code loads it like any
channel. Point a `.mcp.json` server at the built CLI and launch:

```bash
claude --dangerously-load-development-channels --channels server:parley
```

> **Dev-flag note.** During the channels research preview, loading a self-built channel requires
> `--dangerously-load-development-channels` (official channels are allowlisted; this is the
> motivated self-hoster's one extra flag, not a blocker). Channels require **Claude Code v2.1.80+**
> and **claude.ai *or* a Console API key** (not available on Bedrock/Vertex/Foundry).

The full end-to-end walkthrough — including driving a real fakechat loop — is in
[`examples/fakechat-loopback/MANUAL-CHECKLIST.md`](examples/fakechat-loopback/MANUAL-CHECKLIST.md).

## Remote / chat mode (v0.2)

Run the same bridge as a public HTTP server with an OAuth front door so a **Claude chat / web /
mobile connector** can `post` and `fetch_recent` against it. Single-tenant: the instance
authenticates exactly one owner; backend credentials stay server-side and Claude only ever holds a
consented, audience-bound token. Discovery (RFC 9728 PRM), dynamic client registration, PKCE, and
token rotation are all handled. Full setup — HTTPS, the public-exposure constraint, and Anthropic
IP-range allowlisting — is in [`examples/self-host-remote`](examples/self-host-remote/README.md).

```ts
import { createOAuthRemoteApp, ownerVerifierFromPassphrase } from '@parley/core';
import { SqlitePlugin } from '@parley/sqlite';
// plugin.connect(...) once, then:
const app = createOAuthRemoteApp(plugin, cfg, {
  issuerUrl: new URL('https://parley.example.com'),
  verifyOwner: ownerVerifierFromPassphrase(process.env.PARLEY_OWNER_PASSPHRASE!),
});
await app.listen(3000);
```

## Conventions

- **Catch up on session start.** A Code instance calls `parley_fetch_recent` per topic at startup,
  then on demand. See [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) for the `CLAUDE.md` snippet.
- **Chat handoff.** The chat side uses only `parley_post` + `parley_fetch_recent`; conventions live
  in the [`skills/chat-handoff`](skills/chat-handoff/SKILL.md) skill. One seam, one write path —
  do **not** install a separate backend-specific MCP in chat.

## Backends

| Backend | Package | Cursor source | Subscribe (live) | Status |
|---|---|---|---|---|
| SQLite | `@parley/sqlite` | rowid (AUTOINCREMENT) | poll loop | ✅ v0.1 |
| Redis | `@parley/redis` | stream entry id (`XADD`) | `XREAD BLOCK` (event-driven) | ✅ v0.3 |
| Matrix | `@parley/matrix` | event_id | filtered `/sync` long-poll | ✅ v0.4 |
| NATS | `@parley/nats` | JetStream seq | `consume()` ordered consumer | ✅ v0.5 |
| XMPP | `@parley/xmpp` | MAM/stanza-id | MUC live + MAM (needs **MAM**) | ✅ v0.5 |

Every backend passes the **same** `@parley/conformance` suite; adding each touched zero core.

Each network backend's README will point to the canonical upstream Docker setup (we don't author
production compose files); a maintainer throwaway compose for tests lives under `examples/`.

## Security

- **Topic allowlist.** The bridge only touches the explicit `topics` list — no wildcard default.
- **Inbound is untrusted.** Backend messages become agent context, never privileged instructions.
- **Secrets** (tokens/JIDs/creds) live in `backend_config` / `.env`, never in core, never committed.
- **`skip_permissions` defaults OFF**, sandbox-only.
- **Remote/chat mode (v0.2)** will use a single-tenant OAuth 2.1 + PKCE front door; backend creds
  stay server-side and Claude only ever holds a consented token.

## What this fills

A standalone, MCP-native, **backend-agnostic seam** for human ↔ chat-bot ↔ coding-agent context
hand-off. Point bridges do one transport; local agent buses do one paradigm; big platforms bury
the seam inside. Parley is the small, give-away seam: *implement five methods, get a Parley backend
for your transport.* (See `DESIGN.md` §16–17 for prior art and attribution.)

## Keywords

`mcp` · `model-context-protocol` · `mcp-server` · `claude` · `claude-code` · `claude-channels` ·
`agent-messaging` · `agent-to-agent` · `a2a` · `multi-agent` · `agent-coordination` ·
`context-sharing` · `context-handoff` · `task-handoff` · `agent-handoff` · `message-bus` ·
`message-queue` · `pub-sub` · `transport-agnostic` · `pluggable-backend` · `backend-agnostic` ·
`matrix` · `nats` · `redis` · `xmpp` · `sqlite` · `self-hosted` · `chat-to-code` ·
`human-in-the-loop` · `inter-agent-communication` · `agent-bus`

## License

[MIT](LICENSE)
