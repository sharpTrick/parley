# @sharptrick/parley-redis

Redis Streams backend for [Parley](../../README.md) — the **first event-driven** backend. Implements
the seam in `packages/bridge-redis/src/index.ts`; adding it required **zero** `@sharptrick/parley-core` changes.

## Mapping

| Seam | Redis |
|---|---|
| topic | one Stream per topic, key `<prefix><topic>` (default prefix `parley:`) |
| `post` | `XADD <key> * {sender, content, ts, in_reply_to}` |
| cursor / backendMsgId | the Stream entry id (`XADD *`, e.g. `1700-0`) — monotonic per stream |
| `fetchRecent({since})` | `XRANGE <key> (since +` (exclusive); no `since` → `XREVRANGE … COUNT` window |
| `subscribe` | **`XREAD BLOCK`** loop on a dedicated connection — real events, not a poll timer |
| `resolveIdentity` | string convention (handle = backendRef) |

Stream ids aren't lexically comparable, but core never compares cursors — Redis returns entries in
order and `fetchRecent` is exclusive on `since`.

**`fetch_recent` long-poll (`block_ms`).** `fetchRecent` also accepts an optional request-level
`block_ms`: when nothing is newer than `since`, the call holds up to `block_ms` for a new message
before returning (possibly empty), so a polling agent's token cost scales with messages, not
wall-clock time. Redis serves this natively via an `XREAD BLOCK` on a dedicated reader connection.
Core caps the wait at `catchup.block_max_ms` (default 60s); `0`/omit preserves the immediate-return
catch-up semantics. (Distinct from the `block_ms` config knob above, which is `subscribe`'s
shutdown re-check interval.)

## Config (`backend_config`)

```yaml
backend_config:
  url: "redis://127.0.0.1:6379"   # default
  key_prefix: "parley:"            # default
  block_ms: 2000                   # XREAD BLOCK timeout (shutdown re-check interval)
  retention_days: 30               # optional; omit to keep every entry forever (the default)
```

## Retention (optional)

`retention_days` trims entries older than the window using `XADD`'s own `MINID` trim option — no
separate job, no extra connection. It rides on every `post`: each `XADD` also tells Redis to
(approximately) drop stream entries below the cutoff `MINID`, since a stream id's leading
component is a millisecond timestamp. It's off by default — entries are kept forever unless you
opt in.

Two things worth knowing: trimming is **approximate** (the `~` modifier lets Redis batch the trim
for O(1) amortized cost instead of an exact O(log N) trim on every write — harmless, since core
never compares cursor values), and it's **opportunistic** — a topic that stops receiving posts
keeps its full history until its next post, because nothing else triggers a trim. There's no error
for "this much history is gone"; a reader that's been offline longer than the window just gets
fewer entries back on catch-up.

## Multiple concurrent sessions (one `backend_config` per config file, same server)

A real deployment is several configs — one per Claude Code session plus one for the remote/chat
server — all pointed at the same Redis. `url`, `key_prefix`, and `retention_days` must be
**identical** across every one of them:

- **`url`** — the obvious one: a mismatch means different servers, no shared history, no error
  either way.
- **`key_prefix`** — the hidden one. It reads like cosmetic namespacing, but topic `"ctx-payments"`
  under prefix `parley:` is a **completely different Redis key** than under `app:`. Every other
  field (`topics`, etc.) can look perfectly consistent while history silently splits in two.
- **`retention_days`** — trimming rides on `XADD` to a stream **shared** by every writer to that
  topic. Whichever config has it set enforces it for every session touching the topic, not just
  itself; divergent values mean inconsistent, most-aggressive-wins enforcement over time.
- **`block_ms`** is safe to vary per session — it's a per-instance timeout, not shared state.

Runnable multi-config examples (two Code sessions + a remote/chat config, all sharing one Redis):
[`examples/multi-session/redis`](../../examples/multi-session/README.md).

## Run Redis

Use the **official `redis` Docker image** (not authored here):

```bash
docker run -d --name parley-redis -p 6379:6379 redis:7-alpine
```

(or the maintainer dev harness: `examples/dev-compose/`.)

## Conformance

```bash
docker run -d --name parley-redis -p 6379:6379 redis:7-alpine
npm test   # the shared @sharptrick/parley-conformance suite runs green against Redis
```

`PARLEY_REDIS_URL` overrides the URL; the suite skips itself if no server is reachable.
