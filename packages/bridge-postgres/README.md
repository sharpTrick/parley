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

The NOTIFY payload (the new `seq`) is a **hint only** — payloads are size-limited and delivery is
best-effort across reconnects, so subscribers always re-query from their last-seen cursor. A
coalesced or dropped notification costs latency, never a message. The channel name is
`'parley_' || md5(topic)`: fixed length, so any topic string stays under PostgreSQL's 63-byte
identifier limit with no injection surface.

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
(`<table_name>_senders`, `_topic_seq`, `_notify`, `_notify_trg`) and PostgreSQL truncates
identifiers at 63 bytes — a longer stem would silently make two of those the same relation.

`retention_days` deletes rows older than the window on connect and hourly thereafter. `seq` is a
`BIGSERIAL` and is never reused, so a cursor minted before a prune stays valid: a stale reader
just gets fewer rows back, never a wrong or duplicate one.

Every key is validated before the pool is opened, and `connect()` rejects — naming the key — on an
unrecognised key (a typo would otherwise silently disable the feature), a `pool_size` that is not
an integer in `1..1000`, or a `retention_days` that is not a finite number greater than zero
(`0`, a negative value or `null` would delete the entire history on connect).

Secrets belong in the config/`.env`, never committed (CLAUDE.md conventions).

## Multiple concurrent sessions (one `backend_config` per config file, same database)

Any number of bridge processes may share one database — this is the natural multi-machine
step up from SQLite's shared file. `url` and `table_name` must be **identical** across every
config:

- **`url`** — a mismatch means different databases: no shared history, no error either way.
- **`table_name`** — the hidden one. Topic `"ctx-payments"` in table `parley_messages` is a
  completely different table than in `app_messages`; every other field can look consistent while
  history silently splits in two.
- **`pool_size`** is safe to vary per session — it's per-instance capacity, not shared state.

Cross-process write safety is structural, not configured: `post` wraps every insert in a
transaction that takes `pg_advisory_xact_lock(hashtext(topic))` first. `BIGSERIAL` assigns `seq`
at INSERT time, not COMMIT time, so without the lock a larger `seq` could become visible before
a smaller one commits and a catch-up reader would skip the late row forever. The per-topic lock
serializes same-topic commits into `seq` order (distinct topics don't contend), which is what
keeps the cursor monotonic and lossless under genuinely concurrent writers — the conformance
suite's `concurrentPost` check drives N independent plugin instances against one table to prove
it.

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

## Conformance

```bash
npx vitest run packages/bridge-postgres   # the shared @sharptrick/parley-conformance suite
```

`PARLEY_PG_URL` overrides the URL; the suite skips itself if no server is reachable. Each test
context uses a throwaway `parley_test_*` table and drops it (plus its trigger function) on
cleanup.
