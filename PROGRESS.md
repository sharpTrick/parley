# PROGRESS.md — Parley build notes

> Running progress note + context-rehydration anchor. Durable state = **git history + a green
> conformance run + this file**. Any context window can be cleared and rebuilt from these three.
> Format: what's done · what's verified · what's blocked · doc-vs-design discrepancies.

## Status

- **Phase:** v0.1 (seam-proving gate), main-thread serial build.
- **Done:** Task #1 toolchain · S-1..S-4 scaffold/seam/Message · C-1..C-5 core engine ·
  Q-1..Q-4 sqlite plugin. All committed, full suite green.
- **P-1 channel gate: PASSED** (findings + auth discrepancy recorded below). Push code may proceed.
- **In progress:** P-2..P-5 push half + reply + headless loopback (Task #5).

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

## Blocked / needs human

- Real `claude --channels` fakechat loopback (P-5 live half) needs an interactive Claude Code session
  (v2.1.80+, claude.ai/Console auth). Automated substitute = headless InMemoryTransport harness +
  `examples/fakechat-loopback/MANUAL-CHECKLIST.md`.
