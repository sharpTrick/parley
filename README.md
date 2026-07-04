# Parley

[![CI](https://github.com/sharpTrick/parley/actions/workflows/ci.yml/badge.svg)](https://github.com/sharpTrick/parley/actions/workflows/ci.yml)

> Parley — a transport-agnostic MCP seam for messages, context sharing, and task hand-off
> between humans, chat bots, and coding agents. One pluggable interface; runs on self-hosted
> SQLite, Postgres, Redis, Matrix, XMPP, NATS, or Zulip — or hosted Discord, Telegram, and
> Slack. Bridges Claude chat ↔ Claude Code via native channels.

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
> - **The seam held:** adding every backend after the first touched **zero** `@sharptrick/parley-core` code
>   (`git diff` confirms it). One interface, five transports, one suite.
> - **v0.6** five more backends: **Postgres** (`LISTEN`/`NOTIFY` push) and **Zulip** (event
>   queue) self-hosted, plus the first hosted-SaaS trio — **Discord** (gateway), **Telegram**
>   (`getUpdates` + local observed store), **Slack** (Socket Mode) — all green on the same
>   conformance suite, still zero core changes.

## How it works

```
 Messaging backend (SQLite | Postgres | Redis | Matrix | XMPP | NATS | Zulip | Discord | Telegram | Slack)
        │  backend-native protocol
 Backend plugin  ── implements the SEAM: connect · disconnect · subscribe · post · fetchRecent · resolveIdentity
        │  normalized Message (topic, sender, content, backendMsgId, cursor, mentions)
 @sharptrick/parley-core    ── reactive tools (post + fetchRecent)  ·  proactive push (<channel> events)
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
  `@sharptrick/parley-core`. A shared conformance suite runs against every backend.

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
# One shared presence topic powers parley_list_users; ttl_ms defaults to 3× heartbeat_ms.
presence: { enabled: true, topic: "parley-presence", heartbeat_ms: 600000 }
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
import { createOAuthRemoteApp, ownerVerifierFromPassphrase } from '@sharptrick/parley-core';
import { SqlitePlugin } from '@sharptrick/parley-sqlite';
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
- **Discover who's live.** Each bridge announces itself with presence heartbeats on one shared
  topic (`presence.topic`, default `parley-presence`), so `parley_list_users` (optional glob, e.g.
  `claude-*`) reports who is on the bus right now — including an idle agent that hasn't posted, with
  the topics each subscribes to — to pick a hand-off target. It reports live Parley participants,
  not a full account directory: a human in a native client shows up once they speak. Because it's a
  single stream, you mute **one** topic to hide presence on a real chat backend; a reactive-only
  chat instance that can't receive pushes can set `presence.enabled: false` to skip heartbeats
  entirely. Derived above the seam from `post`/`fetchRecent`, so it works on every backend with no
  seam change.
- **Post beyond the allowlist.** `topics` is the subscribe/catch-up allowlist; add `post_topics`
  (full-match regexes) to let an instance `parley_post`/`parley_fetch_recent` on ad-hoc topics it
  doesn't subscribe to. The configured topics (and any post patterns) are surfaced in the MCP tool
  descriptions, so an agent discovers what it may post to without a separate call.

## Backends

| Backend | Package | Cursor source | Subscribe (live) | Status |
|---|---|---|---|---|
| SQLite | `@sharptrick/parley-sqlite` | rowid (AUTOINCREMENT) | poll loop | ✅ v0.1 |
| Redis | `@sharptrick/parley-redis` | stream entry id (`XADD`) | `XREAD BLOCK` (event-driven) | ✅ v0.3 |
| Matrix | `@sharptrick/parley-matrix` | event_id | filtered `/sync` long-poll | ✅ v0.4 |
| NATS | `@sharptrick/parley-nats` | JetStream seq | `consume()` ordered consumer | ✅ v0.5 |
| XMPP | `@sharptrick/parley-xmpp` | MAM/stanza-id | MUC live + MAM (needs **MAM**) | ✅ v0.5 |
| Postgres | `@sharptrick/parley-postgres` | `BIGSERIAL` seq (advisory-lock ordered) | `LISTEN`/`NOTIFY` (event-driven) | ✅ v0.6 |
| Zulip | `@sharptrick/parley-zulip` | message id (globally monotonic) | event queue + `/events` long-poll | ✅ v0.6 |
| Discord ☁️ | `@sharptrick/parley-discord` | message snowflake | gateway websocket | ✅ v0.6 |
| Telegram ☁️ | `@sharptrick/parley-telegram` | per-chat `message_id` (local observed store — **no pre-join history**) | `getUpdates` long-poll | ✅ v0.6 |
| Slack ☁️ | `@sharptrick/parley-slack` | per-channel `ts` | Socket Mode websocket | ✅ v0.6 |

☁️ = hosted SaaS, unlike the self-hosted core backends — history durability and identity live
under the vendor's policy. Telegram additionally cannot backfill history from before the bot
joined: the Bot API has no history endpoint, so `fetchRecent` replays a local store of messages
the bridge has observed (see the [`bridge-telegram` README](packages/bridge-telegram/README.md)).

Every backend passes the **same** `@sharptrick/parley-conformance` suite; adding each touched zero core.

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
`matrix` · `nats` · `redis` · `xmpp` · `sqlite` · `postgres` · `zulip` · `discord` ·
`telegram` · `slack` · `self-hosted` · `chat-to-code` ·
`human-in-the-loop` · `inter-agent-communication` · `agent-bus`

## License

[MIT](LICENSE)
