# Parley

Plan a task in your Claude chat, hand it to a Claude Code session that catches up on the shared thread and does the work, then read the result back in a chat app you already keep open.

[![CI](https://github.com/sharpTrick/parley/actions/workflows/ci.yml/badge.svg)](https://github.com/sharpTrick/parley/actions/workflows/ci.yml)
[![last commit](https://img.shields.io/github/last-commit/sharpTrick/parley)](https://github.com/sharpTrick/parley/commits/main)
[![npm](https://img.shields.io/npm/v/@sharptrick/parley-core?label=npm)](https://www.npmjs.com/package/@sharptrick/parley-core)
![backends](https://img.shields.io/badge/backends-6_live_%C2%B7_4_fake--conformance-blue)
![conformance](https://img.shields.io/badge/conformance-1_shared_suite-brightgreen)
![license](https://img.shields.io/badge/license-MIT-green)

Parley is an MCP server — the standard way Claude connects to outside tools — that turns your Claude chat, your Claude Code sessions, and you into one shared, durable thread over a messaging backend you choose.

**Contents:** [The loop](#the-loop) · [Two ways in](#two-ways-in) · [Quickstart A — local, 5 min](#quickstart-a-the-local-taste-5-min-zero-infra) · [Quickstart B — chat→Code, 15 min](#quickstart-b-the-chat-to-code-hand-off-remote-mode-15-min) · [Today vs. preview](#what-runs-today-and-whats-still-preview) · [How it works](#how-it-works) · [Backends](#backends) · [Tools](#the-four-mcp-tools) · [Remote / chat mode](#remote--chat-mode) · [Compare](#how-it-compares) · [Status](#project-status--maintenance) · [Docs](#docs--license)

---

## The loop

Your Claude chat and your Claude Code sessions can't talk to each other. Right now *you* are the cable: you copy a plan out of one window, paste it into the other, wait, then ferry the answer back. Parley is the shared thread that lets them confer over a durable backend while you watch from an ordinary chat app.

Keep Matrix open on your phone, run a Claude Code session on your `acme` project, and wire a Claude chat to the same topic — `project-acme`:

1. In your Claude chat, post a self-contained brief to `project-acme`: *"Add retry-with-backoff to the S3 upload path in `uploader.ts`; cap at 5 attempts; add a unit test."* (Under the hood: `parley_post`.)
2. You copy nothing. Go back to what you were doing.
3. A Claude Code session on `acme` starts (as `claude-code-acme`) and, on start, calls `parley_fetch_recent` on `project-acme` — catch-up-on-start over the durable backend, not a live push — reading your brief as if it had been in the room the whole time, though it wasn't running when you posted. (The [chat-handoff skill](skills/chat-handoff/SKILL.md) is what wires this fetch to fire automatically on session start.)
4. It does the work — edits `uploader.ts`, adds the test, runs it — then posts the result back into the same topic (threaded via `in_reply_to`): *"Done — added `withBackoff()`, capped at 5, test `retries on 503` passing."*
5. You read the answer where you asked it — the whole plan → hand-off → result thread lands in your ordinary Matrix app. No terminal, no copy-paste.

---

## Two ways in

The full chat→Code loop above needs **remote mode**: a Claude chat lives in Anthropic's cloud and can't reach a stdio server on your laptop, so chat joins the thread over an HTTP connector, not a local file. Two on-ramps — price the gap before you start:

- **[Kick the tires in 5 minutes](#quickstart-a-the-local-taste-5-min-zero-infra)** — *no accounts, no domain, no server; Node ≥ 22.* A local taste on one SQLite file, Code↔Code. It proves the whole shared-thread spine end to end; the only thing left off is the chat seat.
- **[The real hand-off](#quickstart-b-the-chat-to-code-hand-off-remote-mode-15-min)** — *needs a public HTTPS URL + a claude.ai connector; ~15 min.* chat→Code over remote/OAuth mode. The maintainer runs this remote-mode hand-off in production, in a hardened Keycloak/OIDC + Zulip variant (see [Remote / chat mode](#remote--chat-mode)); Quickstart B is the lighter built-in-OAuth + SQLite on-ramp to the same mode.

**About the phone.** The hero's *"read it back in a chat app you already keep open"* is the full loop — remote mode **plus** a chat backend — so it's Quickstart B with one swap, not the 5-minute path. Today the honest, live-proven phone pick is **Matrix** (or XMPP with a MAM server); the consumer apps most people keep open are still `fake-conformance` ([details](#what-runs-today-and-whats-still-preview)). Quickstart B lands chat→Code and reads back in Claude chat; its [*Land it on your phone*](#quickstart-b-the-chat-to-code-hand-off-remote-mode-15-min) step swaps SQLite for Matrix to also drop the thread onto your phone.

---

## Quickstart A: the local taste (5 min, zero infra)

*The deliberate local taste — two Claude Code sessions, two directories, one SQLite file — the shared-thread spine with the chat seat left off (that's [Quickstart B](#quickstart-b-the-chat-to-code-hand-off-remote-mode-15-min)). No broker, no server, no flags.*

**Prereqs:** Node ≥ 22, two Claude Code sessions, ~5 min — no accounts, no domain, no server.

Give each session its own directory so their configs and `.mcp.json` don't collide; both point at the same `db_path`, which *is* the bus.

**1. Install core plus the SQLite backend** (in each directory):

```bash
npm install @sharptrick/parley-core @sharptrick/parley-sqlite
```

**2. Write a `parley.config.yaml` in each directory** — identical except the handle:

```yaml
# planner/parley.config.yaml   (coder/ is identical but handle: "coder")
backend: local-sqlite            # selects the @sharptrick/parley-sqlite plugin
identity:
  handle: "planner"              # session B uses "coder"
topics:
  - "ctx-demo"
backend_config:
  db_path: "../parley-demo.db"   # BOTH sessions point at this one file — it is the bus
```

> Defaults are catch-up-only and safe (no live push, `skip_permissions: false`). The rest of the knobs live in [`DESIGN.md`](DESIGN.md); you need none of them for the aha.

**3. Point a `.mcp.json` in each directory at the stdio server:**

```json
{
  "mcpServers": {
    "parley": {
      "command": "npx",
      "args": ["parley-sqlite", "--config", "parley.config.yaml"]
    }
  }
}
```

> `parley-sqlite` is the bin shipped by `@sharptrick/parley-sqlite` — the only runnable binary Parley ships; `npx` resolves it from your local install.

**4. Run the hand-off.** Open two Claude Code sessions, one per directory (`planner` and `coder`), both resolving to the same `parley-demo.db`:

- In `planner`: *"post `plan: add retry-with-backoff to uploader.ts, cap at 5` to ctx-demo"* → it runs `parley_post`.
- In `coder`: *"fetch recent on ctx-demo, then reply with a result"* → it runs `parley_fetch_recent`, reads `planner`'s brief **even though it wasn't running when planner posted**, and replies with `parley_post` + `in_reply_to`.
- Back in `planner`: *"fetch recent on ctx-demo"* → the coder's threaded reply is right there.

> Here you trigger each fetch by hand to watch it work; in a wired session the on-start catch-up from [The loop](#the-loop) fires automatically.

That's the round-trip. `parley_fetch_recent` hands back the message plus the bookmark that makes catch-up durable:

```json
{
  "messages": [
    {
      "topic": "ctx-demo",
      "senderHandle": "planner",
      "content": "plan: add retry-with-backoff to uploader.ts, cap at 5",
      "backendMsgId": "1",
      "cursor": "1",
      "mentions": [],
      "timestamp": "2026-07-12T18:03:11.204Z"
    }
  ],
  "nextCursor": "1"
}
```

<details>
<summary><strong>Why this survives a restart (optional)</strong></summary>

`nextCursor` is the whole trick: persist it, pass it back as `since`, and the next catch-up returns only messages *newer* than it — never re-sending one you already read. Kill `coder` mid-hand-off and start it again: it catches up from its bookmark, re-reads the thread, and loses nothing. Then swap `backend: local-sqlite` for Redis / NATS / Matrix and the *same* participants run across machines with zero code changes — correctness lives in the seam, not in any one host. The mechanics (`cursor`, `backendMsgId`) are spelled out in [How it works](#how-it-works).
</details>

---

## Quickstart B: the chat-to-Code hand-off (remote mode, ~15 min)

The loop the hero promised — a Claude chat plans, a Claude Code session does the work — over the built-in OAuth front door. No external identity provider for this light path.

**Prereqs:** a public HTTPS URL (a one-command tunnel works) and a claude.ai connector, ~15 min. Node ≥ 22 for the server; no external IdP on this light path.

1. **Run the [self-host-remote](examples/self-host-remote/README.md) reference server** as an HTTP server (same seam, a local SQLite backend, just spoken over HTTP). Set `PARLEY_OWNER_PASSPHRASE` locally and start it on `127.0.0.1:3000`.
2. **Put it behind HTTPS.** Claude requires a public HTTPS endpoint. The fastest way is one tunnel command (install [`cloudflared`](https://github.com/cloudflare/cloudflared) first):

   ```bash
   cloudflared tunnel --url http://127.0.0.1:3000
   ```

   Set `PARLEY_ISSUER_URL` to the `https://…trycloudflare.com` URL it prints. That URL is ephemeral — for a stable one, front the server with Caddy/nginx instead (there's a ready Caddyfile in the [self-host README](examples/self-host-remote/README.md)).
3. **Add a claude.ai connector** pointed at `https://parley.example.com/mcp` (your HTTPS URL + `/mcp`). Claude runs discovery → dynamic client registration → PKCE; on the consent page, enter your **owner passphrase** to authorize. Backend creds never leave the server — Claude holds only a consented token.
4. **Hand off.** In your Claude chat, `parley_post` a brief to `project-acme`. A Claude Code session on that project catches up on start with `parley_fetch_recent` and does the work — so the brief is waiting whether or not any session was live when you posted.

Step 4 is the real, in-production shape: chat→Code lands over the **durable catch-up** path. The other half — an *already-running* session reacting the instant you post — is the live-push preview ([below](#what-runs-today-and-whats-still-preview)), not needed here. Full recipe + connector gotchas + the optional **Keycloak/OIDC** front door: [`examples/self-host-remote/README.md`](examples/self-host-remote/README.md).

> **Optional — land it on your phone.** Quickstart B reads back in Claude chat. To get the hero's phone experience, swap the SQLite backend for **Matrix** — the live-proven phone pick ([backends](#backends)): point `backend:` at the Matrix plugin, keep the same topics, and the plan → hand-off → result thread also shows up in an ordinary Matrix app on your phone. Same seam, zero participant-code changes; config is in the [`bridge-matrix` README](packages/bridge-matrix/README.md).

---

## What runs today, and what's still preview

Two delivery paths — one is the product, one is a preview. Stated once, here:

**Tier 1 — durable catch-up (the product, works today).** `parley_post` + `parley_fetch_recent` over standard MCP: a session catches up on start from the backend's own store, with ordering and dedup from the cursor + `backendMsgId`, never timestamps. Live-tested on 6 of 10 backends against real implementations — SQLite as a real on-disk file, plus real Redis/NATS/Postgres servers and live Matrix/XMPP homeservers — with no subscription, no flag, and on the SQLite path no server at all. This is what buys restart-survival, a swappable backend, and a human reading in a real chat app — and it's what the remote hand-off in [Quickstart B](#quickstart-b-the-chat-to-code-hand-off-remote-mode-15-min) rides.

**Tier 2 — live `<channel>` push (research preview).** Proactive events into an *already-running* Code session, riding Claude Code's native `claude/channel` capability. Verified **headless-only** — an InMemoryTransport harness plus a human [manual checklist](examples/fakechat-loopback/MANUAL-CHECKLIST.md) — and **not yet demonstrated in a real interactive Claude Code session.** It needs Claude Code v2.1.80+, a claude.ai subscription or a Console API key (not Bedrock, Vertex, or Foundry), and the `--dangerously-load-development-channels` flag against the fakechat loopback (`--channels plugin:fakechat@claude-plugins-official`). It rides Anthropic's research preview and may break on any Claude Code release — treat it as experimental, never load-bearing: a dropped or duplicated push is reconciled by the next `parley_fetch_recent`, and Tier 1 stands on its own.

**Reading on your phone.** Of the 6 `live` backends, Matrix is a mainstream chat app with clients on every phone — the honest end-to-end pick right now (XMPP is the other, given a MAM-enabled server). The consumer apps most people already keep open — Zulip, Slack, Discord, Telegram — are `fake-conformance` today (see the table below; Zulip is additionally the maintainer's operator-run production backend). So for the loop end-to-end on live-proven code, reach for Matrix.

---

## How it works

Three numbers: **10 backends**, each implementing the same **6 seam methods**; Claude itself calls just **4 MCP tools**.

The *seam* is that one small interface every backend implements. All the hard, backend-independent logic — live push, catch-up, dedup, ordering, presence, reply fan-out, OAuth mode — is written once above it in `@sharptrick/parley-core`. Dependencies point one way: a plugin depends on core, never the reverse.

```
 Messaging backend   SQLite · Redis · Postgres · Matrix · XMPP · NATS · Zulip · Discord · Slack · Telegram
        │  backend-native protocol
 Backend plugin      implements the seam (the six methods below)
        │  normalized Message (topic · sender · content · backendMsgId · cursor · mentions)
 @sharptrick/parley-core   reactive tools (post · fetchRecent)   +   proactive push (<channel> events)
        │            dedup + ordering via cursor · reply fan-out · presence · topic allowlist · OAuth mode
   ┌────┴───────────────────────────┐
 Claude Code                     Claude chat  ·  you, in a normal chat client
 catch-up + live push (preview)  post + fetchRecent
```

The whole product is these six seam methods:

```ts
interface BackendPlugin {
  connect(config): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(topic, handler): Promise<void>;                       // live path (push)
  post(topic, identity, content, opts?): Promise<BackendMsgId>;   // the single durable write
  fetchRecent({ topic, since?, limit? }): Promise<{ messages, nextCursor }>; // catch-up
  resolveIdentity(handle): Promise<BackendIdentity>;
}
```

Two invariants make a backend correct: a stable, unique `backendMsgId` (the **dedup key** — how core throws away a message it has already seen) and a **monotonic** `cursor` (an opaque, ever-advancing per-topic position). Catch-up is exclusive on `since`: it returns only messages *newer* than the cursor you pass, never re-sending it (ordering is the plugin's job; core never compares cursor values, so the cursor stays opaque). The one absent-topic escape hatch is `NoSuchTopicError`; every other rejection is a real failure and propagates.

Adding every backend after SQLite changed **zero** lines of `@sharptrick/parley-core` — check the `git log` — and one shared conformance suite proves each against the same contract.

> **Add a backend.** Implement the six methods, point the shared conformance suite (`@sharptrick/parley-conformance`) at your plugin, and ship it as its own package — core never has to know it exists. The Redis backend is a complete, conformant example in one small file: `post` = `XADD`, `fetchRecent` = `XRANGE` (stream id as the cursor), `subscribe` = a blocking `XREAD` loop. Every transport maps its native position onto the cursor (SQLite `rowid`, Redis stream id, Postgres `BIGSERIAL`, … — full mapping in the table below). → [`packages/bridge-redis/src/index.ts`](packages/bridge-redis/src/index.ts)

---

## Backends

Ten backends — six live-tested against real implementations, four proven against in-process API fakes of the vendor protocol. The **Verified** column tells you which is which, so "10 backends" never reads as "10 live-tested backends."

| Backend | Transport / mechanism | Cursor | Verified |
|---|---|---|---|
| SQLite | local file, polling-only (WAL, no broker) | `rowid` | `live` |
| Redis | Redis Streams, blocking `XREAD` push | stream id | `live` |
| Postgres | table + `LISTEN` / `NOTIFY` push | `BIGSERIAL` | `live` |
| Matrix | hand-rolled Client-Server HTTP + `/sync` | sync token | `live` |
| XMPP | MUC + MAM archive (server must enable MAM) | MAM id | `live` |
| NATS | JetStream (persistent streams) | stream sequence | `live` |
| Zulip | event-queue long-poll (raw `fetch`) | message id | `fake-conformance` + operator-run |
| Discord | gateway websocket (raw `ws`) | snowflake (Discord's time-sortable id) | `fake-conformance` |
| Slack | Socket Mode websocket (raw `ws`) | `ts` | `fake-conformance` |
| Telegram | Bot API `getUpdates` + local observed store | per-chat `message_id` | `fake-conformance` |

- **`live`** — exercised against real implementations in CI/dev: SQLite on a real on-disk file, real Redis/NATS binaries, live Synapse/Prosody homeservers, and Postgres 16 (SQLite, Redis, Matrix, NATS, XMPP, Postgres — 6 of 10).
- **`fake-conformance`** — the same shared suite run against in-process fakes of the vendor API, not live vendor accounts: Zulip, Discord, Slack, Telegram (4 of 10). Zulip is additionally operator-run (the maintainer's own instance, below) and ships an env-gated real-credential suite (`PARLEY_ZULIP_URL` / `_EMAIL` / `_API_KEY`) that runs the identical seam suite against a live Zulip server. Telegram's Bot API has no pre-join history endpoint, so that backend documents the gap rather than faking backfill.

Every backend clears the identical seam contract — cursor monotonicity, exclusive-`since` catch-up, and double-delivery dedup — plus multi-process write safety wherever the transport allows concurrent writers (Telegram is single-writer by design: one bridge per bot token, since a second `getUpdates` poller gets HTTP 409, so that one conformance case is deliberately skipped). No vendor SDKs: Matrix is a hand-rolled HTTP client (not matrix-js-sdk), Discord and Slack use raw `ws`, Telegram and Zulip use raw `fetch`.

---

## The four MCP tools

Distinct from the six seam methods a backend implements, these are the 4 tools Claude actually calls:

- **`parley_fetch_recent`** — catch a topic up from the durable backend. `{topic, since?, limit?}` → `{messages, nextCursor}`.
- **`parley_post`** — publish or hand off into a topic (thread with optional `in_reply_to`). `{topic, content, in_reply_to?}` → `{backendMsgId}`.
- **`parley_reply`** — reply into the topic an inbound `<channel>` event arrived from. Like `parley_post`, it's written durably to the backend — the live channel is only the fast inbound hop, so a reply survives restart and shows up in the next catch-up.
- **`parley_list_users`** — the reachability roster for hand-off: who's online now *plus* recently-seen-but-offline peers, derived above the seam (bridges beat hello/heartbeat/goodbye on one shared presence topic) so it works identically on every backend, with no new seam method.

---

## Remote / chat mode

The same codebase runs as a public HTTP MCP server so a Claude chat connector can reach it directly — the mechanism behind [Quickstart B](#quickstart-b-the-chat-to-code-hand-off-remote-mode-15-min). It sits behind a standards-compliant built-in OAuth 2.1 + PKCE front door (dynamic client registration; standards-based discovery (RFC 9728) and audience binding (RFC 8707) — details in the [docs](docs/keycloak-integration.md)), or delegates to an external IdP in OIDC mode (Keycloak is the tested target). It's single-tenant: backend credentials stay server-side, and Claude only ever holds a consented, audience-bound token.

For a hardened setup, the maintainer runs Parley as their own single-tenant instance behind a Keycloak/OIDC front door (issuer at `auth.example.com`) fronting a self-hosted Zulip backend (`zulip.example.com`), TLS terminated at a reverse proxy and reachable over a private tailnet — shipped infrastructure, not a roadmap slide. That's optional hardening; the built-in OAuth front door in Quickstart B is the light path.

**Security posture:** secrets live in `backend_config` / `.env`, never in core and never committed. A client-side topic allowlist plus anchored `post_topics` regexes bound each instance (e.g. `general` + `project-.*`). Inbound messages are treated as untrusted data, never as privileged instructions. SQLite uses WAL for safe concurrent multi-process writes, and `retention_days` pruning is opt-in on SQLite/Redis/NATS.

---

## How it compares

- **vs. localhost agent buses** (xats, claude-peers-mcp, AgentBus): the one thing they fundamentally can't do is put a human reading and replying in an ordinary chat app — on their phone, off the machine. Those buses are localhost-only and agents-only. Parley is the same primitives — topics, presence, `claude/channel` push — but off one machine and carrying a human plus a Claude chat too. **Should you switch from xats today?** Not for live push: xats rides the same experimental `claude/channel` capability, and Parley's is still preview-grade ([above](#what-runs-today-and-whats-still-preview)) — concede that. Switch when you want a human in a real chat app, cross-host sessions, or a durable backend you can swap: the same participants run on a local SQLite file today and Redis / NATS / Matrix / Zulip across machines tomorrow with zero participant-code changes.
- **vs. a plain MCP server:** Parley is dual-role. A request/response server can answer `post` / `fetch_recent`; it can't proactively push a `<channel>` event into a session that's already running. Parley does both (the push half is the research preview above).
- **What it isn't:** not an agent framework (A2A, AutoGen, MindRoom) — deliberately just the seam. No built-in chat UI.

---

## Project status & maintenance

- **Single maintainer, MIT, no hosted service.** It runs on infrastructure you operate — no lock-in, deliberately just the seam.
- **Pre-1.0 (`v0.8.0`), actively developed.** See the [GitHub Releases](https://github.com/sharpTrick/parley/releases) for cadence; the last-commit badge up top is the live pulse. Per project convention, early breaking changes land as `feat:` until 1.0 is deliberately cut.
- **The one risk to price in.** The product (Tier 1 durable catch-up) stands alone and depends on nothing unstable — six methods, ten backends, and zero core changes are the evidence the seam is stable. The only experimental dependency is Tier 2 live push, which rides Anthropic's `claude/channel` research preview and may break on any Claude Code release — [scoped above](#what-runs-today-and-whats-still-preview), never load-bearing.
- **Releases are automated.** A merge to `main` *is* a release: CI runs the test gate, then `semantic-release` picks the version bump from the PR title and publishes every package to npm in lockstep with provenance (OIDC — no tokens). See [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **Contributing.** Dev setup, running the shared conformance suite, and the pre-PR checklist are in [`CONTRIBUTING.md`](CONTRIBUTING.md); extending Parley with a new backend is the [*Add a backend*](#how-it-works) callout above.
- **Support:** open a GitHub issue; report vulnerabilities via [`SECURITY.md`](SECURITY.md).

---

## Docs & license

- [`DESIGN.md`](DESIGN.md) — the source of truth for the seam, cursors, delivery paths, and security model.
- [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) — catch-up-on-start and the hand-off conventions.
- [`docs/keycloak-integration.md`](docs/keycloak-integration.md) — OIDC / Keycloak remote-mode setup.
- [`skills/chat-handoff/SKILL.md`](skills/chat-handoff/SKILL.md) — the chat-handoff skill (the full, runnable chat→code walkthrough).
- [`examples/fakechat-loopback/MANUAL-CHECKLIST.md`](examples/fakechat-loopback/MANUAL-CHECKLIST.md) — the headless live-push loopback and its manual checklist.
- [`examples/self-host-remote/README.md`](examples/self-host-remote/README.md) — the public remote-MCP reference deployment (the ~15-minute recipe behind Quickstart B).
- [`examples/dev-compose/docker-compose.yml`](examples/dev-compose/docker-compose.yml) — throwaway backends for testing (point at upstream canonical Docker setups for production).
- Per-backend details live in each [`packages/*/README.md`](packages).

*A parley is a conference between parties to reach an understanding — which is all Parley is: one durable thread where your Claude chat, your Claude Code sessions, and you confer.*

MIT licensed.