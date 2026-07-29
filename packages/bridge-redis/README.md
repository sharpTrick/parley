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
  connect_timeout_ms: 5000         # how long the first handshake may take before connect() fails
  retention_days: 30               # optional; omit (or null) to keep every entry forever (default)
```

`retention_days` must be a positive number of days. `0`, a negative value, `NaN`, a quoted string
and a value large enough to reach past the epoch are all rejected by `connect()` with an error
naming the key — none of them mean "keep everything", and several of them silently delete history.
Omit the key (or set it to `null`) for the default: keep every entry forever. There is no
"trim everything" mode.

An unreachable or wrong `url` makes `connect()` fail within `connect_timeout_ms` with
`parley-redis: cannot reach <host>:<port>` on stderr — it never hangs waiting for a server that
isn't there. While Redis is down, `post`/`fetchRecent` reject rather than queueing for the length
of the outage; the client reconnects on its own once the server is back.

## Credentials & exposure

Redis has **no authentication by default** and its wire protocol is plaintext. An exposed parley
Redis lets anyone read every topic's full history (agent context, hand-offs) and `XADD` forged
messages under any `sender` — which the bridge then feeds into a live Claude Code session.

- Bind published ports to loopback (`-p 127.0.0.1:6379:6379`). Docker's port publishing writes its
  own iptables rules, so a bare `-p 6379:6379` is reachable from the network **even behind a host
  firewall**.
- Always set a password (`--requirepass`) and pass it in the URL:
  `url: "redis://:${REDIS_PASSWORD}@127.0.0.1:6379"`. Keep the value in `.env` / your secret
  store — never in a committed config file.
- Use `rediss://` (TLS) whenever the server is not on localhost; the URL carries the password in
  cleartext otherwise.
- For the remote/chat deployment (DESIGN §10), reach the server over a private network, a
  WireGuard/Tailscale link or an SSH tunnel. Do not publish 6379 to the internet.

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
docker run -d --name parley-redis -p 127.0.0.1:6379:6379 redis:7-alpine \
  redis-server --requirepass "$REDIS_PASSWORD"
```

(or the maintainer dev harness: `examples/dev-compose/`.) See
[Credentials & exposure](#credentials--exposure) before pointing anything but localhost at it.

## Conformance

```bash
docker run -d --name parley-redis -p 127.0.0.1:6379:6379 redis:7-alpine \
  redis-server --requirepass "$REDIS_PASSWORD"
PARLEY_REDIS_URL="redis://:$REDIS_PASSWORD@127.0.0.1:6379" npm test
```

`PARLEY_REDIS_URL` overrides the URL; the suite skips itself if no server is reachable.
