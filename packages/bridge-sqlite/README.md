# @sharptrick/parley-sqlite

The **seam-proving reference backend** for [Parley](../../README.md) — zero-infra,
**polling-only** (no socket, no broker). Implements the seam in
`packages/bridge-sqlite/src/index.ts` and ships the `parley-sqlite` CLI that wraps
`@sharptrick/parley-core`'s stdio bridge. This is the backend v0.1 was built and verified against first.

## Mapping

| Seam | SQLite |
|---|---|
| topic | `topic` column value; one shared `messages` table, filtered per query |
| `post` | `INSERT INTO messages (topic, sender, content, ts, in_reply_to)` → `lastInsertRowid` |
| cursor / backendMsgId | the row `id` (`AUTOINCREMENT`) — monotonic and unique per topic |
| `fetchRecent({since})` | `SELECT ... WHERE topic = ? AND id > ? ORDER BY id ASC` (exclusive); no `since` → last-`limit` window, reversed to ascending |
| `subscribe` | a per-topic **poll loop**: `SELECT ... WHERE id > :lastSeen` every `poll_interval_ms`, advancing `lastSeen` |
| `resolveIdentity` | string convention (handle = backendRef) — local backend, not a provisioned account |

There's no real event source to block on, so `subscribe` polls. The cursor makes this fully
correct regardless of cadence — `poll_interval_ms` is a pure latency/cost knob, never a
correctness concern.

A `since` cursor that points past the database's high-water mark (one minted before the file was
recreated, or by a previous `:memory:` process) **replays that topic from its first row** rather
than binding `id > <stale>` and returning nothing. Catch-up therefore self-heals after a reset
without skipping messages, whether or not the topic is empty — but clearing core's persisted
read-state when you reset the DB is still the right operational step.

### When the database goes away under a live subscription

A poll tick that fails is classified, not blanket-retried. Lock contention (`SQLITE_BUSY`/
`SQLITE_LOCKED`) retries silently. Anything that can heal — I/O errors, a read-only remount, a
full disk, a file briefly unopenable while a backup swaps it — is logged, then the loop **backs
off exponentially (to 30 s) and keeps probing**, so the topic resumes delivering by itself. Only
unrecoverable damage (a corrupt file, a dropped table) stops the loop. Because stderr is routinely
discarded by an MCP stdio host, the state is also readable programmatically:

```ts
plugin.subscriptionHealth();
// [{ topic: 'ctx', state: 'live' | 'degraded' | 'stopped', consecutiveFailures, lastError }]
```

The retention prune reports failures the same way (quiet for lock contention, a rate-limited
stderr line otherwise), so a retention policy the process cannot enforce is never silent.

**`fetch_recent` long-poll (`block_ms`).** `fetchRecent` accepts an optional `block_ms`: when
nothing is newer than `since`, the call holds up to `block_ms` for a new message before returning
(possibly empty), so a polling agent's token cost scales with messages, not wall-clock time. SQLite
is polling-only, so there's no native block to serve this — it comes for free from core's generic
long-poll wrapper (a short internal poll-and-recheck), zero plugin change. Core caps the wait at
`catchup.block_max_ms` (default 60s); `0`/omit preserves the immediate-return catch-up semantics.

## Config (`backend_config`)

```yaml
backend_config:
  db_path: "./parley.db"     # default "parley.db" in cwd; ":memory:" is single-process only
  poll_interval_ms: 500       # default 1000 — latency knob only, no correctness impact
  retention_days: 30          # optional; omit to keep every message forever (the default)
```

Every field is validated at `connect()`, before the database is opened, and a bad value fails
fast with the offending key in the message rather than being absorbed:

| Field | Accepted | Rejected |
|---|---|---|
| `db_path` | any non-empty string | `""`, non-strings |
| `poll_interval_ms` | integer `10` … `2147483647` | `0` (a hot loop), negatives, fractions, values above the `setTimeout` ceiling (Node silently clamps those to 1 ms) |
| `retention_days` | any number `> 0` | `0` and negatives — **not** "disabled"; they would delete the entire history. Omit the key for "keep forever" |

Unknown keys are rejected too, so `retention_day: 30` is a startup error rather than a silent
no-op.

## Retention (optional)

`retention_days` prunes rows older than the window on a background timer (checked hourly, plus
once immediately at connect). It's off by default — messages are kept forever unless you opt in;
`0` is **not** the way to say "disabled" (it means "delete everything up to now") and is rejected.
Safe to turn on at any time: `id` is `AUTOINCREMENT` and never reused, so a `cursor`/`backendMsgId`
minted before a prune stays valid — a reader that's been offline longer than the window just gets
fewer rows back on catch-up, never a wrong or duplicate one. There's no error or signal for "this
much history is gone"; it's a silent trim, so treat `retention_days` as "how much history do I
actually want to keep," not just a storage-cap safety valve.

## Multiple concurrent sessions (one `backend_config` per config file, same file)

A real deployment is several configs — one per Claude Code session plus one for the remote/chat
server — all pointed at the same `.db` file. `db_path` and `retention_days` must be **identical**
across every one of them:

- **`db_path`** — a mismatch is a **silent split, not an error**. Two configs pointing at different
  paths (including the *same relative path* launched from two different working directories!) just
  get two independent, mostly-empty-looking histories; nothing ever complains. Use an **absolute
  path** in any multi-session deployment.
- **`retention_days`** — the prune query has no topic filter, so it deletes from the whole shared
  file regardless of which topics *that* config subscribes to. Any one session that sets it prunes
  history every other session depends on too; if configs disagree, the most aggressive value wins
  over time (deletes are irreversible).
- **`poll_interval_ms`** is the one field that's genuinely safe to vary per session — it's a pure
  per-instance latency knob.

Runnable multi-config examples (two Code sessions + a remote/chat config, all sharing one file):
[`examples/multi-session/sqlite`](../../examples/multi-session/README.md).

## Cross-process safety

Every connection opens with `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 5000`, and
`PRAGMA synchronous = NORMAL` (`src/driver.ts`) — readers never block the writer, and a concurrent
`post` from another bridge instance retries instead of erroring. This is what makes multiple
bridge processes writing the same file (or the conformance suite's `concurrentPost` check) safe.

The store is created `0600` (the file is claimed at that mode *before* the driver opens it, so it
is never briefly world-readable) and its `-wal`/`-shm` sidecars are narrowed to match. A store
found wider than `0600` is tightened with a line on stderr naming it; if it cannot be tightened —
the usual cause is a second bridge running as a different UID — that is reported too, rather than
leaving the deployment to assume the store is protected.

The driver prefers the mature native **`better-sqlite3`**, falling back to Node's built-in
**`node:sqlite`** if the native module fails to load (no prebuilt binary for your platform/ABI and
no toolchain to build one). Both are synchronous and support the same PRAGMAs; the plugin code
above the driver doesn't care which one is active.

## Run it (CLI)

```bash
npm install && npm run build
parley-sqlite --config parley.config.yaml
# or: node packages/bridge-sqlite/dist/cli.js --config parley.config.yaml
# or: PARLEY_CONFIG=parley.config.yaml parley-sqlite
```

It's a stdio MCP server — stdout is the JSON-RPC channel, all diagnostics go to stderr. See the
[root README quickstart](../../README.md#quickstart-v01-local-sqlite--claude-code) for wiring it
up as a Claude Code channel, and
[`examples/fakechat-loopback`](../../examples/fakechat-loopback/MANUAL-CHECKLIST.md) for a full
live walkthrough (including driving the loop from a second shell).

## Tests / conformance

```bash
npx vitest run packages/bridge-sqlite
```

No external service required — this is the only backend with no `docker`/`dev-compose`
dependency. The shared `@sharptrick/parley-conformance` suite runs against a scratch database,
including the `concurrentPost` check: forked OS processes (`src/concurrent-writer.mjs`) write the
same file while the plugin's own `post()` writes into it, so the shipped write path is one of the
contending processes rather than a spectator.

`test/multi-process.test.ts` covers the pragmas themselves: each one is asserted through an
observable consequence (`PRAGMA` read-back, the `-wal` sidecar appearing on disk, a contended
write retrying for the full `busy_timeout` window and `post()` waiting out a lock another OS
process holds), so silently dropping one turns a test red. It also compares the DDL produced by
every creator of the `messages` table — the plugin and the forked writer fixture — and fails on
drift, since whichever process creates the file first decides the shape for all of them.
