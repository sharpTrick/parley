# PROGRESS.md — Parley build notes

> Running progress note + context-rehydration anchor. Durable state = **git history + a green
> conformance run + this file**. Any context window can be cleared and rebuilt from these three.
> Format: what's done · what's verified · what's blocked · doc-vs-design discrepancies.

## Status

- **Phase:** ✅ **v1 COMPLETE.** All five backends green on the shared conformance suite; remote
  OAuth mode done. **96 tests across 21 files.** Adding every backend after the first touched
  **zero** `@parley/core` code (verified by `git diff`). The seam held end to end.
- **Backends (all conformance-green):** SQLite (poll) · Redis (`XREAD BLOCK`) · Matrix (Synapse C-S
  API, `/sync`) · NATS (JetStream `consume()`) · XMPP (Prosody MUC + MAM). Matrix + XMPP were
  implemented by parallel agents against live Synapse/Prosody and integrated/re-verified here.
- **Infra note:** servers run via plain `docker run` (no Compose plugin on this host); Synapse
  needed relaxed rate limits + a registered user; the Matrix conformance run uses an opt-in
  `shared_room` to stay under Synapse's per-user room-creation limit (production default =
  room-per-topic). v1-wrap: README/TASKS updated, DESIGN §17 re-scanned (niche still unclaimed).
- **Done (all committed, clean build + 57 tests green):** Task #1 toolchain · S-1..S-4
  scaffold/seam/Message · C-1..C-5 core engine · Q-1..Q-4 sqlite plugin · P-1..P-5 push half +
  reply + headless loopback · V-1 conformance suite · V-2 skill+conventions · V-3 README.
- **v0.1 gate evidence:** (a) `@parley/conformance` green vs `bridge-sqlite` incl. forked
  4-process × 25-post write test; (b) headless loopback green (channel capability advertised,
  push delivered with identifier-keyed meta, reply durable, dedup holds).
- **P-1 channel gate: PASSED** (findings + auth discrepancy recorded below).

## SEAM FREEZE (post-v0.1)

The seam (`packages/bridge-core/src/seam.ts`, `message.ts`) and the conformance suite
(`@parley/conformance`) are FROZEN. Any later need to change them is a ⚠ design smell to surface,
not absorb. Backend skeletons (`bridge-redis/matrix/xmpp/nats`) are pre-scaffolded + registered in
the root tsconfig/vitest so parallel agents touch ONLY their own package dir. Success criterion
for every backend after sqlite: zero `bridge-core` changes; conformance green.

## Toolchain — verified empirically (2026-06-25, Node v26.2.0)

| Choice | Resolution |
|---|---|
| MCP SDK | `@modelcontextprotocol/sdk@1.29.0`. Exports restructured: top-level `./server`, `./client`, `./experimental` + a `./*` wildcard. |
| Import specifiers (confirmed loadable) | low-level `Server` ← `@modelcontextprotocol/sdk/server/index.js`; `McpServer` ← `/server/mcp.js`; `StdioServerTransport` ← `/server/stdio.js`; `ListToolsRequestSchema`/`CallToolRequestSchema` ← `/types.js`; `InMemoryTransport` ← `/inMemory.js`; `Client` ← `/client/index.js`. |
| `Server.notification` | exists, signature `(notification, options?)`; accepts arbitrary `{ method:'notifications/claude/channel', params:{content,meta} }`. Constructor accepts `capabilities.experimental['claude/channel']` + `instructions`. We build core on the **low-level `Server`**. |
| SQLite | **better-sqlite3 12.11.1** loads on Node 26 (prebuilt `.node` present; WAL + busy_timeout + AUTOINCREMENT all work). **node:sqlite `DatabaseSync`** works with no flag — documented fallback behind a 4-method `driver.ts`. |
| zod | `3.25.76` (^3) — aligns with the SDK's zod; one copy in the tree. |
| Tests | vitest 2.x + esbuild run fine; `@parley/*` aliased to each package's `src/` so unit/conformance tests need no pre-build. |
| TS | ESM, `moduleResolution: NodeNext`, `tsc -b` project references. Relative imports use explicit `.js` specifiers (NodeNext). |

## Channel-docs verification gate (P-1) — performed before any push code

Source: live `code.claude.com/docs/en/channels` + `/channels-reference`.

- A channel **is** an MCP **stdio** server (spawned as a subprocess) declaring
  `capabilities.experimental['claude/channel'] = {}` (+ `tools: {}` for two-way) + an `instructions`
  system-prompt string, on the **low-level `Server`**.
- Push = `server.notification({ method: 'notifications/claude/channel', params: { content: string, meta: Record<string,string> } })`
  → rendered to Claude as `<channel source="parley" ...metaAttrs>content</channel>`.
- **META KEYS MUST BE IDENTIFIERS** `/^[A-Za-z_][A-Za-z0-9_]*$/` — **hyphenated keys are silently dropped.**
  Values may contain hyphens. So our meta keys are `topic, sender, cursor, msg_id, mentions, timestamp`
  (never `msg-id`). A runtime regex guard enforces this in `channel-emit.ts`.
- Reply/react tools are **ordinary MCP tools** (arbitrary names) registered via `setRequestHandler`.
- Loaded via `--channels plugin:fakechat@claude-plugins-official`; `--dangerously-load-development-channels`
  bypasses the research-preview allowlist. Requires Claude Code **v2.1.80+** (permission relay v2.1.81+).
- Notifications are best-effort / not acknowledged — matches DESIGN §6 "any notify mechanism can be best-effort."

### ⚠ Discrepancy found (docs win, per CLAUDE.md)

- **Auth:** DESIGN.md §2.2 says "API-key / Console auth is **not** supported for the channel path."
  **Live docs say** channels require "Anthropic authentication through claude.ai **or a Console API key**"
  (not available on Bedrock/Vertex/Foundry). → Following docs: do **not** hard-block on claude.ai-only;
  README/manual checklist states "claude.ai subscription **or** Console API key."

## Open decisions made (reversible; noted inline in code where load-bearing)

- Order is a **plugin guarantee** (fetchRecent returns pre-sorted ascending, exclusive `since`); core never
  compares cursor values. Reconciles DESIGN §6's "orders on cursor" + "cursor opaque to core."
- Per-instance read-state lives in **core** as an atomic JSON file (not the message DB).
- Shared conformance suite is its **own package** `@parley/conformance`.

## v0.2 COMPLETE (R-1..R-6) — verified

Remote/chat mode done: stateless Streamable-HTTP transport (reactive-only) + single-tenant
OAuth 2.1 + PKCE front door (SDK `mcpAuthRouter` + `requireBearerAuth` + a `ParleyOAuthProvider`
with owner-consent gate, DCR, rotating refresh, RFC 8707 audience binding). Verified headlessly
acting as Claude's connector: 401→PRM discovery, DCR, PKCE authorize, owner consent, token, then
post/fetch over MCP. `examples/self-host-remote` reference deploy + README (Anthropic IP allowlist
160.79.104.0/21). 72 tests green; **zero `bridge-core` seam changes** forced by v0.2.

## Infra reality for the parallel phase (probed 2026-06-25) — HARD BLOCKER

- **No Docker/Podman daemon; no redis-server/nats-server/prosody/ejabberd/synapse binaries.**
  Network egress works (npm + general fetch OK), BUT **downloading + running external server
  binaries is denied by the sandbox** (nats-server download blocked). So network-backend
  conformance **cannot be verified here** without the user enabling Docker / authorizing binary
  downloads / running servers. Surfaced to the user for a decision.
- Consequence: **network-backend conformance can't run against real servers via Docker here.**
  - **v0.2 Remote/OAuth** — needs NO external server (HTTP+OAuth over the same SQLite). Fully
    verifiable here → doing it first.
  - **v0.3 Redis / v0.5 NATS** — investigate no-Docker paths: `redis-memory-server` (downloads a
    redis binary) and the `nats-server` release binary (single Go binary, downloadable). If they
    run, conformance can be green here.
  - **v0.4 Matrix / v0.5 XMPP** — realistically need a full homeserver/Prosody (Docker). Plan:
    implement the plugin code against the seam + ship dev-compose + README; mark conformance
    "verify on a Docker host" (honest, not silently skipped).

## ▶▶ RESUME HERE — network backends (once Docker is available)

**Context:** v0.1 (`@parley/core` + `@parley/sqlite`, local stdio, catch-up + polling push + reply)
and v0.2 (remote Streamable-HTTP + single-tenant OAuth front door) are done, committed, and green
(72 tests). The seam (`packages/bridge-core/src/seam.ts`, `message.ts`) and `@parley/conformance`
are FROZEN. Both v0.1 and v0.2 required **zero** seam changes.

**Decision taken:** user is installing Docker + docker permissions and rebooting; on resume, build
the 4 network backends and run the shared conformance suite GREEN against real servers.

**Everything is staged for immediate resumption:**
- Backend skeletons exist + compile + are registered: `packages/bridge-{redis,matrix,xmpp,nats}/`
  (stub classes `RedisPlugin`/`MatrixPlugin`/`XmppPlugin`/`NatsPlugin` that throw "not implemented";
  already in root `tsconfig.json` references and `vitest.config.ts` aliases `@parley/redis` etc.).
- Test infra ready: `examples/dev-compose/docker-compose.yml` (redis:7, nats:2.10 -js, synapse,
  prosody w/ MAM) + its README with first-run steps. Redis/NATS are ready-to-`up`; Synapse/Prosody
  have documented one-time setup and need validating on first real run.

**Order (TASKS.md):** v0.3 Redis → v0.4 Matrix → v0.5 XMPP + NATS. **Success criterion for each:
new-plugin-only, ZERO `bridge-core` changes (`git diff` must show none), conformance GREEN.**

**Per-backend recipe (repeat for each):**
1. `docker compose -f examples/dev-compose/docker-compose.yml up <svc>`.
2. `npm install <client> -w @parley/<name>` — clients: Redis→`redis` (node-redis v4, has XADD/
   XRANGE/XREAD BLOCK); Matrix→`matrix-js-sdk`; XMPP→`@xmpp/client`; NATS→`nats` (nats.js, JetStream).
3. Implement the seam in `packages/bridge-<name>/src/index.ts` (replace the stub), mapping:
   - **Redis** (v0.3, FIRST EVENT-DRIVEN): one Stream per topic (key e.g. `parley:{topic}`).
     `post`=XADD (id=cursor, also the backendMsgId); `fetchRecent`=XRANGE `(since`..`+` exclusive;
     `subscribe`=**XREAD BLOCK** loop (genuine events, not a poll timer — this milestone proves the
     event-driven push path, D-2). Store sender/mentions in the stream fields. `resolveIdentity`=convention.
   - **Matrix** (v0.4): room→topic, `sync` token→cursor, sync loop→subscribe, `/messages` history→
     fetchRecent, `m.room.message` send→post, event_id→backendMsgId. Read `elkimek/matrix-bridge`
     first (E2EE/TOFU/mentions). Cross-machine test = M-5.
   - **XMPP** (v0.5): MUC→topic, **MAM**→fetchRecent/cursor (archive id), PubSub/MUC-presence→
     subscribe, message stanza id→backendMsgId. README MUST note MAM required.
   - **NATS** (v0.5): subject→topic (`parley.{topic}`), JetStream **seq**→cursor, durable/ordered
     consumer→subscribe, `getMessage`/consumer fetch→fetchRecent, seq→backendMsgId.
4. Add `packages/bridge-<name>/test/conformance.test.ts` calling `runConformanceSuite('<name>',
   factory)` where the factory connects to the dev-compose server and provides a `freshTopic()`
   (unique key/room/subject per test) + `cleanup()`. `concurrentPost` is optional (N client conns).
5. Run `npm test` → conformance GREEN. Then `git diff --stat packages/bridge-core` MUST be empty.
6. Per-backend README points at the canonical upstream Docker image (not authored here). Commit.

**Conformance contract a backend must satisfy:** stable-unique `backendMsgId` AND monotonic,
in-order, **exclusive-`since`** cursor delivery (fetchRecent returns pre-sorted ascending). Order is
the plugin's guarantee; core never compares cursor values. Dedup is on `backendMsgId`, never timestamp.

**If a backend seems to need a core change → STOP and surface it (the seam is wrong; fix the seam,
not core).** That has not happened in v0.1 or v0.2 and is the design's whole bet.

**Then v1 wrap:** all backends green on the shared suite; READMEs point to upstream Docker (XMPP
notes MAM); re-scan prior art by function (DESIGN §17); update the main README backend table.

## Blocked / needs human

- Real `claude --channels` fakechat loopback (P-5 live half) needs an interactive Claude Code session
  (v2.1.80+, claude.ai/Console auth). Automated substitute = headless InMemoryTransport harness +
  `examples/fakechat-loopback/MANUAL-CHECKLIST.md`.
