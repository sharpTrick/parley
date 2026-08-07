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
| backendMsgId | the row `id` (`AUTOINCREMENT`) — unique, never reused |
| cursor | `<storeId>.<rowid>` — the row id prefixed with this store's identity (`parley_meta.store_id`); opaque to core |
| `fetchRecent({since})` | `SELECT ... WHERE topic = ? AND id > ? ORDER BY id ASC` (exclusive); no `since` → last-`limit` window, reversed to ascending |
| `subscribe` | a per-topic **poll loop**: `SELECT ... WHERE id > :lastSeen` every `poll_interval_ms`, advancing `lastSeen`; a tick that fills its batch drains again at once rather than waiting the interval |
| `resolveIdentity` | string convention (handle = backendRef) — local backend, not a provisioned account |

There's no real event source to block on, so `subscribe` polls. The cursor makes this fully
correct regardless of cadence — `poll_interval_ms` is a pure latency/cost knob, never a
correctness concern and never a throughput ceiling.

### Cursors carry the store's identity

Core's read-state outlives the database, so a `since` cursor can name a store that no longer
exists — a recreated file, a previous `:memory:` process, or another backend's numeric cursor
arriving through mis-namespaced read-state. Each store mints a random id at first open and prefixes
every cursor with it, so a cursor from anywhere else is recognised as foreign and **replays that
topic from its first row** instead of binding `id > <foreign rowid>` and skipping everything below
it. The same holds for a cursor of this store that sits above the `AUTOINCREMENT` high-water mark,
which is what restoring from an older backup produces. Catch-up therefore self-heals after a reset
without skipping messages, whether or not the topic is empty — clearing core's persisted read-state
on a reset is still tidier, but no longer load-bearing.

A cursor of no recognisable shape (a Matrix-style `s123_456`, an empty string) is rejected with an
error naming it, rather than absorbed as "matches nothing" — absorbing it would re-echo itself as
`nextCursor` and wedge that topic's catch-up silently and forever. Rejecting is not free, and it
does not cost one page: catch-up-on-start propagates the error, so **the bridge exits non-zero on
every start until the stale read-state is cleared** (core's message names the state file and the
fix). A loud stop an operator can act on beats a silent one, but it is a stop. Note the asymmetry —
a foreign cursor that is merely *numeric* (a NATS sequence, a Telegram id) is a shape this backend
can place, so it replays instead of stopping the bridge.

**Page size.** `fetchRecent` serves at most 10000 rows in one page. A `limit` outside `1..10000` —
above the ceiling, below 1, or a non-integer — is rejected outright with an error naming the
ceiling (SQLite reads a negative `LIMIT` as *no* limit). The driver is synchronous and `limit`
reaches it from model-supplied tool arguments, so an unbounded page would stall the whole bridge.
The ceiling rejects rather than silently clamping, so that a caller which treats a short page as
the end of a topic cannot be handed one. Core's own catch-up driver no longer makes that inference —
it stops on an empty page or a non-advancing cursor — but the seam only promises `limit` is a
maximum, so a clamp remains unsafe for any caller that does. Page to exhaustion for more.

Core validates its own `catchup.limit` as any positive integer, so **keep `catchup.limit` at or
below 10000**: a larger value loads cleanly and then stops the bridge during catch-up-on-start, with
an error naming the key. Paging costs nothing — catch-up drains a topic however small the page.

**Identifier range.** `backendMsgId` and the cursor's rowid travel as JS numbers, exact up to
`Number.MAX_SAFE_INTEGER` (2^53−1) — far past any store SQLite will hold in practice. A store
deliberately seeded with rowids above that is not supported: `post()`'s id and the id read back by
`fetchRecent` would round differently.

`backendMsgId` is the bare rowid, so unlike the cursor it carries no store identity and is unique
only **within one store generation**. When you reset or replace the store, discard core's persisted
read-state *and* restart the bridge — core's in-memory seen-set is keyed on `backendMsgId`, so a new
generation's ids `1..N` would otherwise be mistaken for the old generation's and dropped.

### When the database goes away under a live subscription

A poll tick that fails is classified, not blanket-retried. Lock contention (`SQLITE_BUSY`/
`SQLITE_LOCKED`) retries **without a stderr line** — WAL and `busy_timeout` are what resolve it, so
it is the one class not worth reporting. Anything that can heal — I/O errors, a read-only remount, a
full disk, a file briefly unopenable while a backup swaps it — is logged instead, rate-limited to
about one line a minute per topic, with the first hit after a successful read always loud. Only
unrecoverable damage (a corrupt file, a dropped table) stops the loop.

Being quiet is not being healthy: a tick that read nothing delivered nothing, contention included,
so every failing tick raises `consecutiveFailures` whatever its class, only a successful read clears
it, and a run of them past the threshold **backs the loop off exponentially (to 30 s, or to
`poll_interval_ms` when that is longer) while it keeps probing**, so the topic resumes delivering by
itself — backing off never polls a failing store more often than a healthy one. A subscription
failing every read can therefore never report `live` with zero failures. An **embedder** — code that
constructs `SqlitePlugin` itself — can read that state programmatically:

```ts
plugin.subscriptionHealth();
// [{ topic: 'ctx', state: 'live' | 'degraded' | 'stopped', consecutiveFailures, lastError }]
```

There is one record per `subscribe()` call, in the order the loops were started — `subscribe()` on a
topic already subscribed runs a second, independent loop, and reports a second record, so a
supervisor can never read one loop's `live` for another loop that has stopped.

After `disconnect()` every topic reads `stopped` rather than keeping its last live state, so a
supervisor polling this cannot mistake a torn-down plugin for a healthy one. `connect()` refuses to
run twice on one instance — a second one would orphan the running poll loops against the old store —
so re-pointing an embedded plugin means `disconnect()` first, and the health map starts empty again.

Under the shipped `parley-sqlite` CLI there is no route for it: the seam has no plugin-specific
method, so **stderr is the only signal a deployed bridge emits** — capture it. Surfacing subscription
health above the seam needs a core-owned path and is not something this plugin can add alone.

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
| `db_path` | any non-empty filesystem path; `":memory:"` for a single-process store | `""`, non-strings, and anything starting with `file:` — the two drivers read a SQLite URI differently (`node:sqlite` resolves it; `better-sqlite3` opens a file literally named after it), so which store it names would depend on which driver is installed |
| `poll_interval_ms` | integer `10` … `2147483647` | `0` (a hot loop), negatives, fractions, values above the `setTimeout` ceiling (Node silently clamps those to 1 ms) |
| `retention_days` | any number `>= 1/1440` (one minute) whose cutoff is a representable date | `0`, negatives, and any window shorter than a minute — **not** "disabled"; each deletes the entire history on the prune `connect()` runs immediately, so `1e-9` is refused for the same reason `0` is. Omit the key for "keep forever". Also rejected: values so large the cutoff falls outside the representable date range, which would be accepted and then silently never enforced |

Unknown keys are rejected too, so `retention_day: 30` is a startup error rather than a silent
no-op.

## Retention (optional)

`retention_days` prunes rows older than the window on a background timer (checked hourly, plus
once immediately at connect). It's off by default — messages are kept forever unless you opt in;
`0` is **not** the way to say "disabled" (it means "delete everything up to now") and is rejected,
as is any window under a minute, which has the same effect on the first prune.
Safe to turn on at any time: `id` is `AUTOINCREMENT` and never reused, so a `cursor`/`backendMsgId`
minted before a prune stays valid — catch-up across a prune returns fewer rows, never a wrong or a
duplicate one. There's no error or signal for "this much history is gone"; it's a silent trim, so
treat `retention_days` as "how much history do I actually want to keep," not just a storage-cap
safety valve.

**Which rows go is decided by `ts` — the poster's wall clock**, written by whichever process called
`post()`, and not by the cursor the rest of this backend is built on. Two consequences, both
silent. Clock skew between bridges sharing one file shifts which messages survive: a peer whose
host clock runs 2 h behind writes rows that a 1 h window deletes on the very next prune, however
new they are and whatever rowid they hold. And because of that, a message can be pruned **before
any reader's cursor has reached it** — being offline for less than the window does not by itself
guarantee you saw everything; that holds only while the clocks agree. Keep `retention_days` well
above the largest clock skew you expect between hosts sharing the file.

The prune resolves its window through an index on `ts` and deletes in bounded batches, yielding
between them — enabling retention on a large existing store must not hold the file's single write
lock (or the event loop) long enough to push a peer bridge's `post()` past its `busy_timeout`.

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

"Every connection" is enforced, not assumed. The WAL conversion is the one pragma with a
precondition — SQLite refuses a journal-mode change under a peer's write lock, and does not consult
`busy_timeout` for it — so a first-boot race (two bridges opening a brand-new file at once) is
bounded-retried and the resulting mode is then read back. A connection that did not reach WAL is
**refused, not served**: `connect()` fails naming the contention rather than running the store in a
rollback journal, where readers block the writer and `synchronous = NORMAL` is no longer
corruption-safe. WAL is persistent, so the race exists only until the file is first converted —
retrying the connect resolves it.

`synchronous = NORMAL` buys that throughput at a stated price: in WAL mode a transaction that has
already committed **can be lost on power loss or an OS crash** before the next checkpoint (the file
itself is never corrupted — this is a durability trade, not an integrity one). So a `post()` can
return a `backendMsgId`, the agent can report the hand-off as delivered, and that message can be
gone after an unclean shutdown, with the poster's read-state already advanced past it. `FULL` is
not offered as a knob; if you need commit-level durability, this backend is the wrong one for that
deployment.

The store is created `0600` (the file is claimed at that mode *before* the driver opens it, so it
is never briefly world-readable) and its `-wal`/`-shm` sidecars are narrowed to match. A store
found wider than `0600` is tightened with a line on stderr naming it; if it cannot be tightened —
the usual cause is a second bridge running as a different UID — that is reported too, rather than
leaving the deployment to assume the store is protected.

The driver prefers the mature native **`better-sqlite3`**, falling back to Node's built-in
**`node:sqlite`** if the native module fails to load — either because it is absent (it is an
**`optionalDependency`**, so an install that finds no prebuilt binary for your platform/ABI and no
toolchain to build one skips it and carries on instead of aborting) or because it stopped loading
against this Node (an ABI mismatch after a major upgrade). Both are synchronous and support the
same PRAGMAs; the plugin code
above the driver doesn't care which one is active. `test/driver-parity.test.ts` grades **both**
drivers on one set of assertions — pragma read-back, at-rest mode, insert-result shape and a full
seam round-trip — with the fallback forced, so that parity is a checked claim rather than a
statement about the driver that happened to be installed. `node:sqlite` needs Node ≥ 22.5.

## Run it (CLI)

```bash
npm install && npm run build
parley-sqlite --config parley.config.yaml
# or: node packages/bridge-sqlite/dist/cli.js --config parley.config.yaml
# or: PARLEY_CONFIG=parley.config.yaml parley-sqlite
parley-sqlite --help      # also --version
```

`--config` (or `-c`, or `--config=<path>`) is the only argument. Anything else — a typo, a
`--config` whose value the shell ate — **exits 2 with a usage message** on stderr instead of falling
back to the default `parley.config.yaml`, since that default names a different deployment's store,
handle and topic allowlist. `--help`/`--version` answer on **stdout** and exit 0, so
`V=$(parley-sqlite --version)` and `parley-sqlite --help | less` work; both exit before any server
starts.

It's a stdio MCP server — once it is serving, stdout is the JSON-RPC channel and all diagnostics go
to stderr. See the
[root README quickstart](../../README.md#quickstart-a-the-local-taste-5-min-zero-infra) for wiring it
up as a Claude Code channel, and
[`examples/fakechat-loopback`](../../examples/fakechat-loopback/MANUAL-CHECKLIST.md) for a full
live walkthrough (including driving the loop from a second shell).

## Tests / conformance

```bash
npx vitest run packages/bridge-sqlite
```

No external service required — this is the only backend with no `docker`/`dev-compose`
dependency, and no prior `npm run build` either: the one test that executes the compiled
entrypoint (`src/cli.test.ts`) builds it first if `dist/` is missing or older than `src/`, so it
can never grade a stale artifact. The shared `@sharptrick/parley-conformance` suite runs against a scratch database,
including the `concurrentPost` check: forked OS processes (`src/concurrent-writer.mjs`) write the
same file while the plugin's own `post()` writes into it, so the shipped write path is one of the
contending processes rather than a spectator.

`test/driver-parity.test.ts` grades the pragma read-back: it reads every one back off a live
connection, on both drivers, so silently dropping one turns a test red.
`test/multi-process.test.ts` grades what those pragmas buy, through observable consequences rather
than through the source that sets them — the `-wal` sidecar appearing on disk, a contended write
retrying for the full `busy_timeout` window, `post()` waiting out a lock another OS process holds,
and the live poll loop seeing every row other OS processes commit. It also compares the DDL produced
by every creator of the `messages` table — the plugin and the forked writer fixture — and fails on
drift, since whichever process creates the file first decides the shape for all of them.
