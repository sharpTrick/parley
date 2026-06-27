# @parley/redis

Redis Streams backend for [Parley](../../README.md) — the **first event-driven** backend. Implements
the seam in `packages/bridge-redis/src/index.ts`; adding it required **zero** `@parley/core` changes.

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

## Config (`backend_config`)

```yaml
backend_config:
  url: "redis://127.0.0.1:6379"   # default
  key_prefix: "parley:"            # default
  block_ms: 2000                   # XREAD BLOCK timeout (shutdown re-check interval)
```

## Run Redis

Use the **official `redis` Docker image** (not authored here):

```bash
docker run -d --name parley-redis -p 6379:6379 redis:7-alpine
```

(or the maintainer dev harness: `examples/dev-compose/`.)

## Conformance

```bash
docker run -d --name parley-redis -p 6379:6379 redis:7-alpine
npm test   # the shared @parley/conformance suite runs green against Redis
```

`PARLEY_REDIS_URL` overrides the URL; the suite skips itself if no server is reachable.
