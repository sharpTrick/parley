# @sharptrick/parley-nats

NATS JetStream backend for [Parley](../../README.md) — the network-fabric backend (plugs into a
larger mesh). Implements the seam in `packages/bridge-nats/src/index.ts`; adding it required
**zero** `@sharptrick/parley-core` changes.

## Mapping

| Seam | NATS JetStream |
|---|---|
| topic | one JetStream **stream** per topic (`<stream_prefix><folded topic>`), subject `<subject_prefix><folded topic>` |
| `post` | `js.publish(subject, payload)` → `PubAck.seq` |
| cursor / backendMsgId | the stream **sequence** number (contiguous + monotonic per per-topic stream) |
| `fetchRecent({since})` | ephemeral consumer from `opt_start_seq = since+1` (exclusive); no `since` → last-`limit` window |
| `subscribe` | an ephemeral `consume()` consumer resuming at `DeliverPolicy.StartSequence` `lastSeq+1`, rebuilt on any loss — genuine events, not a poll timer |
| `resolveIdentity` | string convention |

One stream per topic keeps sequence numbers contiguous, so the cursor is a clean per-topic monotonic
integer. Core never compares cursor values — NATS delivers in seq order.

`subscribe` is **not** a nats.js `OrderedConsumer`: it is a plain named ephemeral consumer plus an
explicit watcher. The server GCs such a consumer after 30s of client absence and `consume()` does
not self-heal, so the plugin watches the consumer's status and rebuilds on any loss (deleted, not
found, stream gone, dropped link), resuming at `lastSeq + 1` so messages published during the
outage are backfilled rather than skipped. The connection itself reconnects without an attempt
limit — an outage longer than the driver's default budget must not permanently deafen the bridge.

### Topic → subject / stream names

NATS subject tokens may not contain `.`, `*`, `>` or whitespace, and stream names also bar `/` and
`\`. Those characters fold to `_` — and because that fold is many-to-one, a folded name also carries
a `-<sha1-10>` suffix over the raw topic so two distinct topics can never collide onto one stream.
Topics that are already legal are used verbatim:

| topic | subject (default prefix) | stream (default prefix) |
|---|---|---|
| `deploys` | `parley.deploys` | `PARLEY_deploys` |
| `team.chat` | `parley.team_chat-<sha1-10>` | `PARLEY_team_chat-<sha1-10>` |
| `ops/oncall` | `parley.ops/oncall` | `PARLEY_ops_oncall-<sha1-10>` |
| `red team` | `parley.red_team-<sha1-10>` | `PARLEY_red_team-<sha1-10>` |

So `nats stream ls` shows the bare name only for already-legal topics; anything folded carries the
hash suffix.

**`fetch_recent` long-poll (`block_ms`).** `fetchRecent` accepts an optional `block_ms`: when
nothing is newer than `since`, the call holds up to `block_ms` for a new message before returning
(possibly empty), so a polling agent's token cost scales with messages, not wall-clock time. NATS
serves this natively via a JetStream `StartSequence` pull consumer with expiry. Core caps the wait
at `catchup.block_max_ms` (default 60s); `0`/omit preserves the immediate-return catch-up semantics.

## Config (`backend_config`)

```yaml
backend_config:
  servers: "127.0.0.1:4222"   # string or list; default
  subject_prefix: "parley."    # default; topic → subject parley.<topic>
  stream_prefix: "PARLEY_"     # default; topic → stream PARLEY_<topic>
  retention_days: 30           # optional; omit to keep every message forever (the default)

  # Auth — pick one; secrets belong in backend_config/.env, never in core, never committed.
  token: "…"                   # token auth
  user: "alice"                # user/password auth
  pass: "…"
  creds_file: "/etc/parley/user.creds"   # NATS .creds (JWT + nkey seed), e.g. NGS
  nkey_seed: "SU…"             # raw nkey seed; prefer creds_file

  # TLS material (file paths)
  tls:
    ca_file: "/etc/parley/ca.pem"
    cert_file: "/etc/parley/client.pem"
    key_file: "/etc/parley/client-key.pem"
```

`creds_file` wins over `nkey_seed` when both are set. See "Topic → subject / stream names" above for
how a topic is folded onto a subject and a stream.

## Retention (optional)

`retention_days` sets the per-topic stream's native `max_age` at creation time — JetStream's own
built-in retention (this plugin just supplies the value), so no separate pruning code runs here.
It's off by default — `max_age` is unset and JetStream keeps every message forever unless you opt
in. It must be a positive number of days: `0` is rejected at `connect()` rather than passed
through, because JetStream reads `max_age: 0` as *unlimited* — the opposite of what it reads as.
Omit the field for that, don't write `0`. **It only applies when this plugin is the one that creates the stream** (the first `post`,
`fetchRecent`, or `subscribe` on a fresh topic) — changing `retention_days` later does not
retroactively update an already-existing stream; use `nats stream edit` (or recreate it) for that.
As with the other backends, catch-up after the retention window just returns less history, with no
error signaling that anything expired.

## Multiple concurrent sessions (one `backend_config` per config file, same cluster)

A real deployment is several configs — one per Claude Code session plus one for the remote/chat
server — all pointed at the same NATS. `servers`, `subject_prefix`/`stream_prefix`, and
`retention_days` must be **identical** across every one of them:

- **`servers`** — the obvious one.
- **`subject_prefix`/`stream_prefix`** — the hidden one, same story as Redis's `key_prefix`: a
  mismatch silently maps "the same" topic to a different subject/stream while every other field
  still looks consistent.
- **`retention_days`** — the trickiest, because it isn't really "per config" at all: it's **locked
  in at stream creation**. Whichever session's instance is first to touch a brand-new topic wins
  that topic's `max_age` *permanently*; every other config's value for that topic is silently never
  applied. Divergence here is a race, not a choice — keep it identical everywhere so the race is
  harmless.

Runnable multi-config examples (two Code sessions + a remote/chat config, all sharing one cluster):
[`examples/multi-session/nats`](../../examples/multi-session/README.md).

## Run NATS (JetStream)

Use the **official `nats` Docker image** (not authored here); JetStream is a single flag:

```bash
docker run -d --name parley-nats -p 4222:4222 nats:2.10-alpine -js
```

(or the maintainer dev harness: `examples/dev-compose/`.)

## Conformance

```bash
docker run -d --name parley-nats -p 4222:4222 nats:2.10-alpine -js
npm test   # the shared @sharptrick/parley-conformance suite runs green against NATS
```

`PARLEY_NATS_SERVERS` overrides the servers; the suite skips itself if no server is reachable.
