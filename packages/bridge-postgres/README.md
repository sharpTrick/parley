# @sharptrick/parley-postgres

PostgreSQL backend for [Parley](../../README.md) — self-hosted networked SQL, slotting between
SQLite (the zero-infra local floor) and Redis (the broker). One database serves any number of
bridge processes over the network, and **LISTEN/NOTIFY** makes `subscribe` true event-driven
push — no poll timer. Implements the seam in `packages/bridge-postgres/src/index.ts`; adding it
required **zero** `@sharptrick/parley-core` changes.

## Mapping

| Seam | Postgres |
|---|---|
| topic | `topic` column value; one shared message table (default `parley_messages`), filtered per query |
| `post` | advisory-lock-serialized transaction: `INSERT … RETURNING seq` (see below) |
| cursor / backendMsgId | the row `seq` (`BIGSERIAL`) — monotonic and unique per topic |
| `fetchRecent({since})` | `SELECT … WHERE topic = $1 AND seq > $2 ORDER BY seq ASC` (exclusive); no `since` → last-`limit` window, reversed to ascending |
| `subscribe` | **`LISTEN`** on channel `parley_<md5(topic)>`, rung by an `AFTER INSERT` trigger; each notification drains `seq > lastSeen` |
| `resolveIdentity` | `<table>_senders` registry; unknown handles register on first sight with `backendRef = handle` |

Both registration paths (`post` and `resolveIdentity`) insert `ON CONFLICT (handle) DO NOTHING`, so
a row already in `<table>_senders` wins: an operator may pre-register a handle with a `backend_ref`
of their own and `resolveIdentity` returns that instead of echoing the handle.

The NOTIFY payload (the new `seq`) is a **hint only** — payloads are size-limited and delivery is
best-effort across reconnects, so subscribers always re-query from their last-seen cursor. A
coalesced or dropped notification costs latency, never a message. NOTIFY is edge-triggered, so a
drain that *fails* (a killed backend, a `statement_timeout`, a pooler hiccup) is retried on a
doubling backoff rather than waiting for the next write to the topic: nothing is skipped, and a
quiet topic converges without needing a doorbell that may never ring again. The channel name is
`'parley_' || md5(convert_to(topic, 'UTF8'))`: fixed length, so any topic string stays under
PostgreSQL's 63-byte identifier limit with no injection surface. The `convert_to` cast is
load-bearing and not decorative — Node hashes UTF-8 bytes, so the trigger must too, or on a
database whose `server_encoding` is not UTF8 the two digests diverge and the whole live path goes
silently dead. Any off-Parley `NOTIFY` producer or hand-written `LISTEN` client must use the same
spelling.

**`fetch_recent` long-poll (`block_ms`).** `fetchRecent` accepts an optional `block_ms`: when
nothing is newer than `since`, the call holds up to `block_ms` for a new message before returning
(possibly empty), so a polling agent's token cost scales with messages, not wall-clock time.
Postgres serves this natively via `LISTEN`/`NOTIFY` on the topic channel. Core caps the wait at
`catchup.block_max_ms` (default 60s); `0`/omit preserves the immediate-return catch-up semantics.

## Config (`backend_config`)

```yaml
backend_config:
  url: "postgres://parley:parley@127.0.0.1:5432/parley"   # default
  table_name: "parley_messages"   # default; [A-Za-z0-9_] only, max 52 bytes — see below
  pool_size: 5                     # default; max pooled query connections (LISTEN uses one extra)
  retention_days: 30               # optional; omit to keep every message forever
```

`table_name` is capped at 52 bytes because every other relation is derived from it by suffixing
(`<table_name>_senders`, `_topic_seq`, `_created_at`, `_notify`, `_notify_trg`) and PostgreSQL truncates
identifiers at 63 bytes — a longer stem would silently make two of those the same relation. The
name is lower-cased and double-quoted everywhere it reaches SQL, so a reserved word (`user`,
`order`, `table`) is a working table name rather than a bare PostgreSQL parse error. Every
`table_name` rejection is formatted like the other knobs': `parley-postgres: invalid
backend_config.table_name — …`.

`retention_days` (at least 1 minute — `1/1440` of a day — and at most `18250`, about 50 years)
deletes rows older than
the window on connect and hourly thereafter, in batches of 5000 rows per statement: the first prune after
enabling retention on a large table is many short transactions rather than one whose WAL volume,
and whose vacuum-blocking snapshot, grow with the whole backlog. It does not hold `post()` up
either way — deleting old rows never blocks inserting new ones. `seq` is a `BIGSERIAL` and is
never reused, so a cursor minted before a prune stays valid: a stale reader just gets fewer rows
back, never a wrong or duplicate one. The sender registry is not pruned — it is bounded by the
number of distinct handles, not by message volume.

**Which rows go is decided by the database, not by any bridge's clock.** Every row carries a
`created_at TIMESTAMPTZ` the server stamps at insert, and the cutoff is subtracted from the
server's own `now()`, so the answer is the same whichever process prunes and whatever its host
clock says. The `ts` column is the poster's wall clock and is informational only — a bridge running
ten days slow does not lose the messages it just wrote, and one running ten days fast does not
accumulate rows retention can never remove. A table bootstrapped by an older version gains the
column on the next `connect()`; rows already in it are stamped at that moment, so the first window
after the upgrade keeps them slightly longer rather than removing them early.

`connect()` rejects if the plugin is already connected: call `disconnect()` first. A second
`connect()` would otherwise strand the previous pool and prune timer with no way to reclaim them.

Every key is validated before the pool is opened, and `connect()` rejects — naming the key — on an
unrecognised key (a typo would otherwise silently disable the feature), a `pool_size` that is not
an integer in `1..1000`, or a `retention_days` that is not a finite number in `[1/1440, 18250]`.
Both ends of that range are refused rather than clamped: a window shorter than a minute — `0`, a
negative, `1e-9`, or a unit slip that meant milliseconds — empties the entire shared table on the
prune `connect()` runs immediately, and a
window past 18250 days puts the cutoff before any message this backend could have written, which
would leave pruning silently never running while this page says rows are removed hourly.

Secrets belong in the config/`.env`, never committed (CLAUDE.md conventions).

## Multiple concurrent sessions (one `backend_config` per config file, same database)

Any number of bridge processes may share one database — this is the natural multi-machine
step up from SQLite's shared file. `url` and `table_name` must be **identical** across every
config:

- **`url`** — a mismatch means different databases: no shared history, no error either way.
- **`table_name`** — the hidden one. Topic `"ctx-payments"` in table `parley_messages` is a
  completely different table than in `app_messages`; every other field can look consistent while
  history silently splits in two.
- **`pool_size`** may differ per session — it is per-instance capacity, not shared state. It is a
  head-of-line budget for *writes* as well as reads, though: a `post()` holds a pooled connection
  while it waits for its per-topic lock, so `pool_size` posts contending one topic will delay that
  instance's reads until those waits end. They always do end — see below.

`connect()`'s bootstrap is idempotent and, on a table that is already bootstrapped, takes no
table-level lock: the `CREATE TRIGGER` runs only when the trigger is missing. A rolling restart
therefore does not stall the other processes' `post()`s.

Cross-process write safety is structural, not configured: `post` wraps every insert in a
transaction that takes `pg_advisory_xact_lock(hashtext(topic))` first. `BIGSERIAL` assigns `seq`
at INSERT time, not COMMIT time, so without the lock a larger `seq` could become visible before
a smaller one commits and a catch-up reader would skip the late row forever. The per-topic lock
serializes same-topic commits into `seq` order (distinct topics don't contend), which is what
keeps the cursor monotonic and lossless under genuinely concurrent writers.

Every wait on that lock is bounded: `post()` and `connect()`'s bootstrap both run under `SET LOCAL
lock_timeout = 5000`, so a session sitting on the key (an abandoned transaction, a `psql` holding
`pg_advisory_lock`) makes them fail after five seconds with a `parley-postgres: gave up after
5000ms waiting for …` naming the topic or the table, and nothing is written. An unbounded wait
would instead hold a pooled connection forever and take the instance's reads down with it.

A lock is not the only thing that can wait forever. A peer that completes the TCP handshake and
then never speaks — a firewalled port, a stalled pooler, a primary mid-failover — looks to the
driver exactly like a server that is merely slow, and pg's default is to wait indefinitely. So
every socket this backend opens carries a client-side ceiling instead:

- the first connection gives up after `5000ms`, with a `parley-postgres: gave up on …` naming what
  to check rather than a bare driver string;
- a pooled checkout after `15000ms` — deliberately wider than the lock wait, because pg applies
  that ceiling to the queue behind a busy pool as well as to the dial, and a reader waiting its
  turn behind a contended `post()` must wait rather than fail;
- any single statement after `15000ms`, client-side, because what goes missing is the server's
  reply and no `statement_timeout` can notice that;
- `disconnect()` returns within `5000ms` whatever the socket does, destroying a connection that
  will not close rather than waiting on a FIN that is not coming — so a bridge whose database has
  gone quiet still exits on SIGTERM instead of needing SIGKILL.

## Cursors

A cursor from this backend is a decimal `seq` — the `BIGSERIAL` primary key rendered as text — and
`fetchRecent` accepts only that. A `since` that is anything else is refused with a
`parley-postgres: invalid cursor …` error naming the value, before any SQL is issued: a cursor
minted by a different backend, or invented by an agent, is a bad request rather than a query, and
the caller gets a message it can act on instead of a PostgreSQL one.

A `topic`, `content`, handle or `in_reply_to` carrying a NUL byte (`U+0000`) is refused the same
way, before any SQL is issued: `parley-postgres: invalid content — a NUL byte (U+0000) at index
5 …`. A NUL is a legal JSON string character, so an agent can send one, and PostgreSQL's `TEXT`
cannot hold it; left to the server, the caller would get `invalid byte sequence for encoding
"UTF8": 0x00`, which names neither this plugin, nor the field, nor the fact that nothing was
written.

An unpaired surrogate — a `U+D800`–`U+DFFF` code unit with no partner, which is what a `slice()`
through an emoji leaves behind — is refused the same way, and for a worse reason: nothing fails
without the check. The value has no UTF-8 encoding, so the driver sends `U+FFFD` instead, and the
row is stored under a value that is not the one posted. Two topics an anchored `post_topics`
pattern admits as distinct would silently share one history, two handles would collapse onto one
`_senders` row, and `content` would read back altered.

## Run Postgres

Use the **official `postgres` Docker image** (not authored here):

```bash
docker run -d --name parley-postgres -p 5432:5432 \
  -e POSTGRES_USER=parley -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" -e POSTGRES_DB=parley \
  postgres:16-alpine
```

Do not provision `parley`/`parley` outside a throwaway local box: that pair is published in this
repo, and the plugin warns at `connect()` whenever the DSN carries it, whatever host it points at.

(or the maintainer dev harness: `examples/dev-compose/`.)

## Run it (CLI)

```bash
npm install && npm run build
parley-postgres --config parley.config.yaml
# or: node packages/bridge-postgres/dist/cli.js --config parley.config.yaml
# or: PARLEY_CONFIG=parley.config.yaml parley-postgres
parley-postgres --help      # also --version
```

`--config` (or `-c`, or `--config=<path>`) is the only argument. Anything else — a typo, a
`--config` whose value the shell ate — **exits 2 with a usage message** on stderr instead of falling
back to the default `parley.config.yaml`, since that default names a different deployment's another database url, table, handle and topic allowlist.
`--help`/`--version` answer on **stdout** and exit 0; both exit before any connection is opened.
Once it is serving, stdout is the JSON-RPC channel and every diagnostic goes to stderr.

## Conformance

```bash
npx vitest run packages/bridge-postgres   # the shared @sharptrick/parley-conformance suite
```

`PARLEY_PG_URL` overrides the URL; the suite skips itself if no server is reachable. Each test
context uses a throwaway `parley_test_*` table and drops it (plus its trigger function) on
cleanup.
