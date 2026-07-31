# @sharptrick/parley-redis

Redis Streams backend for [Parley](../../README.md) — the **first event-driven** backend. Implements
the seam in `packages/bridge-redis/src/index.ts`; adding it required **zero** `@sharptrick/parley-core` changes.

## Mapping

| Seam | Redis |
|---|---|
| topic | one Stream per topic, key `<prefix><topic>` (default prefix `parley:`) |
| `post` | `XADD <key> * {sender, content, ts, in_reply_to}` |
| cursor / backendMsgId | the Stream entry id (`XADD *`, e.g. `1700-0`) — monotonic per stream |
| `fetchRecent({since})` | `XRANGE <key> (since +` (exclusive), unless `since` is past the stream's last generated id (see below); no `since` → `XREVRANGE … COUNT` window |
| `subscribe` | **`XREAD BLOCK`** loop on a dedicated connection — real events, not a poll timer |
| `resolveIdentity` | string convention (handle = backendRef) |

Stream ids aren't lexically comparable, but core never compares cursors — Redis returns entries in
order and `fetchRecent` is exclusive on `since`.

**A cursor past the stream's high-water mark self-heals.** Core's read-state outlives the Redis it
was minted against, so a `since` can sort *above* the stream's last generated id — a re-created
dataset, a repointed `url`, a changed `key_prefix`, an evicted or deleted key, a peer whose clock
ran ahead. Such a cursor is treated exactly like an unset one: catch-up **replays the most recent
`limit` entries** — messages strictly *older* than the cursor you asked to read after — and returns
a **lower** `nextCursor`. Echoing the dead cursor back instead would wedge that topic forever, with
every later fetch returning the same empty page and nothing to distinguish it from "nothing new".
A cursor at or *below* the last generated id names an entry this stream really did mint, so it is
honoured exclusively and echoed back untouched even when the entries themselves are gone. A cursor
of no recognisable shape (a Matrix-style `s123_456`, `$`, an empty string, a value too large for
the uint64 each id component is) is rejected with an error naming it and the topic.

**`fetch_recent` long-poll (`block_ms`).** `fetchRecent` also accepts an optional request-level
`block_ms`: when nothing is newer than `since`, the call holds up to `block_ms` for a new message
before returning (possibly empty), so a polling agent's token cost scales with messages, not
wall-clock time. Redis serves this natively via an `XREAD BLOCK` on a dedicated reader connection.
Core caps the wait at `catchup.block_max_ms` (default 60s); `0`/omit preserves the immediate-return
catch-up semantics, and a budget below 1ms floors to nothing and returns immediately — `XREAD BLOCK
0` would block forever. A refusal the server will never stop returning (the same `NOAUTH`/`NOPERM`/
`WRONGTYPE` class that stops the `subscribe` loop) fails the call with a labelled error rather than
being reported as an empty long poll, so the operator sees it instead of core re-opening a doomed
reader for every nap of the granted budget. (Distinct from the `block_ms` config knob above, which
is the `subscribe` loop's idle re-arm interval.)

Each parked long poll holds a reader connection for its whole budget, so how many one bridge may
hold at once is **capped at 8**. A call past the cap is served the empty page it can always be
handed and core polls out the rest of its budget, rather than opening a ninth socket — a few hundred
concurrent `fetch_recent` calls would otherwise exhaust `maxclients` on the Redis every peer session
shares. `subscribe` is not capped: live push keeps one reader per subscribed topic.

## Config (`backend_config`)

```yaml
backend_config:
  url: "redis://127.0.0.1:6379"   # default — the server every session shares
  key_prefix: "parley:"            # default — one Stream per topic, key <prefix><topic>
  block_ms: 2000                   # XREAD BLOCK timeout — the subscribe loop's idle re-arm interval
  connect_timeout_ms: 5000         # how long the first handshake may take before connect() fails
  retention_days: 30               # optional; omit (or null) to keep every entry forever (default)
```

Every key is validated by `connect()`, which rejects with an error naming the key rather than
coercing — an unusable value here is silent, not loud. A key this backend does not declare (a typo
like `retention_dayz`, or a knob borrowed from another backend) is rejected too, so a
misconfiguration cannot quietly take the default behaviour. `url` and `key_prefix` must each be a
non-empty string: an empty `url` — what an unexpanded `"${REDIS_URL}"` or an empty secret yields —
would otherwise reach the client library as "unset" and connect to the unauthenticated default
endpoint. `retention_days` must be a positive
number of days (`0`, negative, `NaN`, a quoted string and anything reaching past the epoch are
rejected; none of them mean "keep everything" and several silently delete history). `block_ms` and
`connect_timeout_ms` must be positive whole milliseconds: a fractional or negative `block_ms` makes
the server reject every `XREAD`, which kills live push *permanently* behind a `subscribe()` that
resolved, and `block_ms: 0` blocks the reader forever. Omit a key (or set it to `null`) for its
default.

`block_ms` is a **cost knob, not a latency or shutdown one**: it is how long each `XREAD` parks
before re-arming on an idle stream, so it sets how often an idle subscription round-trips and
nothing else. A message is delivered the moment the parked read wakes, whatever the interval is, and
`disconnect()` destroys the reader socket rather than waiting the interval out — **shutdown does not
wait for `block_ms`**, so raising it costs nothing at teardown and lowering it buys nothing there.

An unreachable or wrong `url` makes `connect()` fail within `connect_timeout_ms` with
`parley-redis: cannot reach <host>:<port>` on stderr — it never hangs waiting for a server that
isn't there. `connect()` also issues one `PING`, so a server that is reachable but cannot serve the
seam (password-protected with no/wrong password, an ACL that forbids the commands, a non-Redis
listener) fails at startup with `parley-redis: connected to <host>:<port> but the server refused a
command: <RESP error>` instead of coming up "connected" and failing on every later tool call.

A refusal that reaches a seam call rather than `connect()` — most often a `key_prefix` colliding
with a key another application already owns — is labelled the same way, naming the plugin, the
topic and the Redis key: `parley-redis: WRONGTYPE … (topic 'ctx-infra', key 'parley:ctx-infra')`.

While Redis is down, `post`/`fetchRecent` reject rather than queueing for the length of the outage;
the client reconnects on its own once the server is back. The `subscribe` loop rides out the same
transient faults, but a fault the server will never stop returning (`NOAUTH`, `NOPERM` after an ACL
change, `WRONGTYPE` if the key is repurposed) stops the loop and writes one line to stderr —
`parley-redis: live delivery STOPPED for topic '<topic>' …` — so a live path that can no longer
deliver never looks like a quiet topic.

A transient fault that in fact never clears — a `MOVED` redirect this non-cluster client can never
follow, a replica stuck `LOADING` — would look quiet too, so the loop backs off (100ms doubling to
2s) and, once several reads in a row have failed, writes one line naming the topic and the server's
own error: `parley-redis: live delivery DEGRADED for topic '<topic>' … still retrying`. It keeps
retrying, and writes a matching `RESUMED` line when a read finally succeeds.

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

There is also a maintainer dev harness, [`examples/dev-compose/`](../../examples/dev-compose/docker-compose.yml),
but it is throwaway test infra, not this recipe: it publishes an **unauthenticated** Redis on the
host's **loopback interface only**, which keeps it off the network but still leaves it readable and
writable by every local user and container on that host. See
[Credentials & exposure](#credentials--exposure) before pointing anything but localhost at it.

## Conformance

From this package's directory (`npm test` here runs only the `bridge-redis` suite; from the repo
root the same command runs every package's):

```bash
docker run -d --name parley-redis -p 127.0.0.1:6379:6379 redis:7-alpine \
  redis-server --requirepass "$REDIS_PASSWORD"
PARLEY_REDIS_URL="redis://:$REDIS_PASSWORD@127.0.0.1:6379" npm test
```

`PARLEY_REDIS_URL` overrides the URL; the suite skips itself if no server is reachable.
