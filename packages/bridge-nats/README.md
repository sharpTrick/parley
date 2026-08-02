# @sharptrick/parley-nats

NATS JetStream backend for [Parley](../../README.md) — the network-fabric backend (plugs into a
larger mesh). Implements the seam in `packages/bridge-nats/src/index.ts`; adding it required
**zero** `@sharptrick/parley-core` changes.

## Mapping

| Seam | NATS JetStream |
|---|---|
| topic | one JetStream **stream** per topic (`<stream_prefix><folded topic>`), subject `<subject_prefix><folded topic>` |
| `post` | `js.publish(subject, payload)` → `PubAck.seq` |
| cursor | `<stream incarnation>-<sequence>`: the stream sequence, strictly increasing within the topic's own stream, qualified by the stream's `created` stamp |
| backendMsgId | `<stream incarnation>-<sequence>`: the sequence qualified by the stream's `created` stamp |
| `fetchRecent({since})` | ephemeral consumer from `opt_start_seq = since+1` (exclusive); no `since` → last-`limit` window |
| `subscribe` | an ephemeral `consume()` consumer resuming at `DeliverPolicy.StartSequence` `lastSeq+1`, rebuilt on any loss — genuine events, not a poll timer |
| `resolveIdentity` | string convention |

One stream per topic keeps the sequence a clean per-topic monotonic integer, which is what the
cursor orders by. Core never compares cursor values — NATS delivers in seq order. The sequence range
is **not** dense: `max_age` retention prunes the front and message deletes punch holes, so `last_seq
- since` is an upper bound on what a page can return, never a count. A page therefore also ends when
the pull falls quiet, not only when that bound is reached: a window's top is a *sequence*, not a
message, so the backwards walk's intermediate windows — and a topic with no message of its own
inside a wider stream, where the tail can only be the stream's — end above anything the topic will
be shown, and a pull sized in sequences would wait out its whole expiry on every read. A page with
no `since` — core's cold start — walks backwards from the topic's tail in
growing windows and stops as soon as it holds `limit` messages, so a deep hole above the topic's own
history costs work proportional to the hole rather than to the history under it.

Only a **write** provisions a topic's stream: `post` and `subscribe` create it, and `fetchRecent`
never does. A read of a topic nobody has posted to returns an empty page with the bare cursor `0`,
which sits below every sequence, so the catch-up that follows the peer's first `post` starts at that
stream's first message. A stream has no client-absence timeout to reclaim it and `retention_days` is
off by default, so one created by a read would be permanent — and topic names reach this plugin from
`post_topics`, which is a regex over names an untrusted inbound message can choose. A blocking read
of a topic with no stream waits for one to appear rather than making it.

`backendMsgId` is the sequence prefixed with the stream's incarnation, because a stream deleted and
re-created out-of-band (`nats stream rm`, a storage reset) restarts its sequences at 1 — the bare
sequence would hand core a dedup key it already holds, and core would drop the new stream's
messages as duplicates. `post` reads that stamp back after its own ack, so a stream re-provisioned
between two posts — with no 503 for the plugin to notice — is caught: the acked sequence is re-read
under the incarnation now on the server, and a post whose message is not the one sitting there is
rejected rather than handed back under an id the survivor will mint again for something else. That
read-back is deliberately best-effort — failing it must not tell a caller to send a message that has
already landed — so one window remains: when the incarnation read itself fails, the id carries the
last incarnation the plugin observed.

The **cursor** carries the same incarnation, for the same reason on the read side: a persisted cursor
naming a sequence of a stream that is gone is a position the new incarnation reaches again for
entirely different messages. Catch-up compares the cursor's incarnation with the stream's, so a
re-provisioned stream is recognised exactly — whether the new incarnation is shorter than the
persisted sequence or has already grown past it — and that read falls back to the retained window,
i.e. it returns what a cold start returns rather than resuming at a sequence the new stream never
assigned. A bare decimal `since` (the pre-0.x cursor form, or a hand-written one) names no
incarnation, so it can only be judged by the tail it sits above — until the next page that returns a
message hands back a qualified one.

`subscribe` is **not** a nats.js `OrderedConsumer`: it is a plain named ephemeral consumer plus an
explicit watcher. The server GCs such a consumer after 30s of client absence and `consume()` does
not self-heal, so the plugin watches the consumer's status and rebuilds on any loss (deleted, not
found, stream gone, dropped link), resuming at `lastSeq + 1` so messages published during the
outage are backfilled rather than skipped. It rebuilds on a break in the consumer's **delivery
sequence** too: `AckPolicy.None` means the server counts a message as delivered the instant it
writes it to the link, so one written into a link that was already gone is never resent, and the
hole in that counter is the only evidence it existed. The connection itself reconnects without an attempt
limit — an outage longer than the driver's default budget must not permanently deafen the bridge.

### Topic → subject / stream names

NATS subject tokens may not contain `.`, `*`, `>`, whitespace or a control character, and stream
names also bar `/` and `\`. A topic is named by a *caller* — `post_topics` is a regex over names an
untrusted inbound message can choose — so all of those fold to `_` here rather than reaching the
server inside a name it cannot parse. Because that fold is many-to-one, a folded name also carries
a `-<sha1-16>` suffix over the raw topic so two distinct topics can never collide onto one stream.
Topics that are already legal are used verbatim:

| topic | subject (default prefix) | stream (default prefix) |
|---|---|---|
| `deploys` | `parley.deploys` | `PARLEY_deploys` |
| `team.chat` | `parley.team_chat-<sha1-16>` | `PARLEY_team_chat-<sha1-16>` |
| `ops/oncall` | `parley.ops/oncall` | `PARLEY_ops_oncall-<sha1-16>` |
| `red team` | `parley.red_team-<sha1-16>` | `PARLEY_red_team-<sha1-16>` |

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

A NATS credential travels in the CONNECT frame of the very first round trip, and nats.js **discards
the URL scheme** before it dials — it decides encryption from `tls:` and the server's INFO alone, so
`tls://` and `wss://` select nothing and every scheme dials the same plain TCP socket. A credential
pointed at a non-loopback host with no `tls:` block is therefore on the wire in the clear unless the
server itself offers TLS: `connect()` warns on stderr, naming the server and which field it would
expose — never its value. Set `tls:` to make encryption a fail-fast guarantee rather than something
the server may or may not offer. A loopback server is not warned about.

## Retention (optional)

`retention_days` sets the per-topic stream's native `max_age` at creation time — JetStream's own
built-in retention (this plugin just supplies the value), so no separate pruning code runs here.
It's off by default — `max_age` is unset and JetStream keeps every message forever unless you opt
in. It must be a positive number of days: `0` is rejected at `connect()` rather than passed
through, because JetStream reads `max_age: 0` as *unlimited* — the opposite of what it reads as.
Omit the field for that, don't write `0`. **It only applies when this plugin is the one that creates the stream** (the first `post`
or `subscribe` on a fresh topic — a `fetchRecent` never creates one) — changing `retention_days` later does not
retroactively update an already-existing stream; use `nats stream edit` (or recreate it) for that.
As with the other backends, catch-up after the retention window just returns less history, with no
error signaling that anything expired.

## Multiple concurrent sessions (one `backend_config` per config file, same cluster)

A real deployment is several configs — one per Claude Code session plus one for the remote/chat
server — all pointed at the same NATS. `servers`, `subject_prefix`/`stream_prefix`, and
`retention_days` must be **identical** across every one of them:

- **`servers`** — the obvious one.
- **`subject_prefix`/`stream_prefix`** — the hidden one, and *unlike* Redis's `key_prefix` a partial
  mismatch does not split history quietly: JetStream's own naming rules make it a hard failure.
  Change `subject_prefix` alone and the second instance addresses the stream the first one created,
  which captures a subject it never publishes to; change `stream_prefix` alone and its `streams.add`
  collides with the first stream's subjects. Either way this plugin refuses at the first
  `post`/`fetchRecent` with an error naming `subject_prefix`/`stream_prefix` and the subjects
  involved, rather than letting the two instances drift. Change **both** and there is no collision
  left to detect: each instance gets its own stream on its own subject, and *that* is the case where
  history splits with no error at all.
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
