# @sharptrick/parley-zulip

A [Parley](../../README.md) backend plugin that carries topics over a self-hosted **Zulip**
server, spoken to via the raw [REST API](https://zulip.com/api/rest) with the global `fetch` —
**no SDK dependency**. Of all the backends this is the closest native fit: Zulip's data model is
literally *streams and topics*, so Parley's topic maps onto a first-class Zulip concept instead of
being emulated.

It implements the frozen seam (`connect / disconnect / subscribe / post / fetchRecent /
resolveIdentity`); adding it required **zero** changes to `@sharptrick/parley-core`.

## Seam mapping

| Seam concept              | Zulip mapping |
| ------------------------- | ------------- |
| `connect(config)`         | No session to establish — Zulip auth is per-request HTTP Basic (`email:api_key`), so `connect` issues no request: it validates and captures config. A **malformed** value — a `site_url` that is not a bare absolute http(s) URL, an empty `email`/`api_key`/`stream`, an unusable `events_timeout_ms` — is a `connect()` error naming the key. What cannot be checked without asking the server — a well-formed URL pointing at the wrong host, a well-formed but wrong `api_key` — surfaces on the first call (401, or a transport error). Calling it again over a live connection disconnects that one first (its queues are deleted against the site it was made with); a rejected config leaves the live connection running. |
| topic → stream + topic    | ONE configured Zulip **stream** (default `parley`) carries all Parley traffic; each Parley topic is a Zulip **topic** within it. |
| `post`                    | `POST /api/v1/messages` (form-encoded — Zulip rejects JSON bodies) with `{ type: "stream", to: <stream>, topic, content }` → returns the new message `id`. |
| `backendMsgId` = `cursor` | The Zulip **message `id`** — a globally monotonic integer (hence per-topic monotonic); serves as both the dedup key and the order key. Zero cursor is `'0'`. |
| `fetchRecent` (no `since`)| `GET /api/v1/messages` narrowed to `<stream, topic>`, `anchor=newest&num_before=N` → the most recent window, ascending. Zulip caps a request at 5000 messages, so a larger `limit` is paginated transparently rather than returned as a 400. |
| `fetchRecent` (`since`)   | `anchor=<since>&include_anchor=false&num_before=0&num_after=N` — the anchor itself is excluded, so `since` is strictly **exclusive** server-side. Zulip returns ascending by id; no client-side reordering. |
| `subscribe`               | `POST /api/v1/register` a `<stream, topic>`-narrowed message **event queue** (only later sends enter it; awaited before subscribe resolves), then a `GET /api/v1/events` long-poll loop. The delivery watermark is read *before* register and the handshake window is gap-filled, so a message racing the handshake is delivered exactly once. Zulip delivers our own sends back to our own queue. Queues idle-GC after ~10 min → on `BAD_EVENT_QUEUE_ID` the loop re-registers and **gap-fills** the dead-queue window through the catch-up path, deduped by last delivered id. `disconnect()` aborts in-flight polls and best-effort deletes the queues. Only a body the server actually sent counts as evidence the queue is alive — our own cap ends a healthy idle poll and a black-holed one identically — so the poll issued after a cap asks for the queue as it stands (`dont_block=true`). Progress is measured by the ACK, not by bytes: a poll that asked to park and came back with nothing — or with events whose ids leave the ack where it was, so the very same answer is served again — is a wake that never came, and is backed off and named on stderr rather than re-issued forever. |
| `resolveIdentity`         | `GET /api/v1/users`, matched on `email` or `full_name` → `backendRef` = the Zulip `user_id`; miss (or error) degrades to `{ handle, backendRef: handle }`. |

`senderHandle` ← `message.sender_email`, `content` ← raw `message.content` (`apply_markdown=false`
everywhere — the bridge wants source text, not rendered HTML), `timestamp` ←
`new Date(message.timestamp * 1000).toISOString()` (informational only — never used for ordering
or dedup).

**`fetch_recent` long-poll (`block_ms`).** `fetchRecent` accepts an optional `block_ms`: when
nothing is newer than `since`, the call holds up to `block_ms` for a new message before returning
(possibly empty), so a polling agent's token cost scales with messages, not wall-clock time. Zulip
serves this natively via the `/api/v1/events` event-queue long-poll. Core caps the wait at
`catchup.block_max_ms` (default 60s); `0`/omit preserves the immediate-return catch-up semantics.

> **`post`'s `identity` argument (your config's `identity.handle`) is not used.** Zulip stamps the
> sender from the authenticated bot account, so a message's `senderHandle` is always that bot's
> **email**, never your `identity.handle` — see "Multiple concurrent sessions" for what that costs
> transcripts. **`inReplyTo` is ignored too:** Zulip has no per-message reply parent; it threads
> *by topic*, and the topic is already Parley's addressing unit.

## Topic names: case-folded, 60 characters, validated

Zulip's topic namespace is not quite Parley's, so the plugin maps between them explicitly:

- **Case is folded.** Zulip matches topics case-insensitively (`ops` and `OPS` are one topic), so
  the plugin lower-cases the topic on the wire — your Parley topic `Ops` is Zulip topic `ops`, and
  a third party posting to `OPS` lands in the same Parley topic rather than a hidden second one.
  Two configured topics that differ only in case are **rejected** (they would share one history).
- **60 characters, hard.** Zulip truncates longer subjects on send, which would make the topic
  write-only — posts land under a name the read narrow never matches. The plugin refuses such a
  topic with a clear error at `post`/`fetchRecent`/`subscribe` instead.

## Message bodies: 10 000 characters, no ragged edges

Zulip normalizes every body it accepts (`zerver/lib/message.py::normalize_body`) before storing it,
so a payload it would rewrite is refused at `post` rather than acknowledged with an id and stored
as something else:

- **10 000 characters, hard** (code points). A longer body is truncated on send and marked
  `[message truncated]` — for a context hand-off, silently. `post` refuses it, naming the measured
  length; split the hand-off instead.
- **Trailing whitespace and leading newlines are stripped** by the server, so a body carrying
  either is refused. Leading *spaces* and all interior whitespace survive untouched.
- **An empty (or whitespace-only) body and a body containing a NUL are rejected** by the server;
  `post` refuses them up front with the reason.

## The one inexactness: topics are mutable

Zulip topics are **mutable namespaces** — admins (and, under the default org policy, members) can
move or rename messages between topics after the fact. Message **ids and cursors survive a move**
(they are global, not per-topic), but topic *membership* can drift: a moved message silently
leaves one Parley topic's history and appears in another's. Practically: dedup and ordering are
rock-solid; topic isolation is only as strong as your server's
[message-move policy](https://zulip.com/help/restrict-moving-messages). For a dedicated Parley
stream with only bots posting, this never happens on its own.

## Config (`backend_config`)

| key                 | default                  | meaning |
| ------------------- | ------------------------ | ------- |
| `site_url`          | `http://127.0.0.1:9991`  | Zulip server base URL (docker-zulip dev default port). **Use `https://` for anything but loopback** — the bot `email:api_key` goes out as an HTTP Basic header on every request; a plaintext non-loopback URL is warned about at `connect`. |
| `email`             | `parley-bot@localhost`   | Bot email for HTTP Basic auth. |
| `api_key`           | `parley-api-key`         | Bot API key for HTTP Basic auth. |
| `stream`            | `parley`                 | The one Zulip stream carrying all Parley topics. |
| `events_timeout_ms` | `25000`                  | Client-side cap on each `/events` long-poll before it is aborted and reissued (un-acked events survive). Clamped to `[250, 600000]` ms, so no value can make the loop spin uncapped. **Sizing it is a rate decision, not a latency one:** every cap spends `2` requests per subscribed topic — the parked poll, then the `dont_block=true` probe that tells a healthy idle cap from a black-holed server — so one topic costs `2 × 60000 / events_timeout_ms` requests a minute (≈5/min at the default; 480/min at the `250` floor) and N topics cost N times that. Zulip bills those against a per-**user** budget whose documented default is `200` requests/minute, so keep `topics × 2 × 60000 / events_timeout_ms` under your server's limit. The floor stops a runaway loop; it does not make every value above it affordable. |

A key `backend_config` does not declare is a **load error** naming it and the accepted set — a
typo'd `api_kye` would otherwise be a silent no-op that authenticates every request with the
built-in default key. Every declared key is validated at `connect()`, which throws naming the
offending key: `site_url` must be a
bare absolute `http(s)` base URL — no `user:password@` (Zulip authenticates from `email`/`api_key`,
and a credential in the URL would be echoed by every diagnostic that names the site) and no query or
fragment — `email`/`api_key`/`stream` must be non-empty, and `events_timeout_ms` must be a positive,
finite number (`0` is an error, not "no cap"). A key that is present but empty (a bare `site_url:`
in YAML) is reported rather than silently replaced by its default. A rejection echoes the offending
value only when its type is the one the key declares; any other type is reported by shape, so a
credential pasted into the wrong key is not disclosed.

Secrets live in `backend_config` / `.env`, never in code.

## Bot credentials

1. In your Zulip organization: **gear → Personal settings → Bots → Add a new bot** (type
   *Generic*). Note the bot's **email** (e.g. `parley-bot@zulip.example.com`) and **API key**
   (shown on the bot card; regenerable there too).
2. Create the Parley stream (default name `parley`) and **subscribe the bot to it** — an event
   queue only sees streams its owner can access.
3. Put `site_url`, the bot `email`, and `api_key` in `backend_config` / `.env`.

### Headless provisioning

The GUI steps above have a scriptable equivalent — useful for minting a **distinct bot per
session** (below) without click-through. Zulip's
[management commands](https://zulip.readthedocs.io/en/stable/production/management-commands.html)
(run as the `zulip` user, e.g. `/home/zulip/deployments/current/manage.py <cmd> --help`) can
create/find the bot user and subscribe it to the stream. A bot's **`api_key` is stable and
reusable** — mint it once and reuse it across restarts (it only changes if you regenerate it),
which is what makes automated per-agent bot provisioning practical.

## Multiple concurrent sessions (one `backend_config` per config file, same server)

A real deployment is several configs — one per Claude Code session plus one for the remote/chat
server — all pointed at the same Zulip. `site_url` and `stream` must be **identical** across all
of them (a `stream` mismatch means sessions look in different places for "the same" topic).
**`email`/`api_key` should each be different**: as noted above, `post()` ignores the seam's
`identity` argument — Zulip stamps the sender from whichever bot is authenticated. Give every
session the same bot and every message from every session shows up as that one bot;
provision a **distinct bot per session** if you want per-session attribution in transcripts —
the same role `identity.handle` plays for SQLite/Redis/NATS, just carried in `backend_config`.
`events_timeout_ms` is safe to vary per session.

### What this costs, and what it does not

What it costs is **transcript attribution**: every message a session posts reads as its bot's email,
so with one shared bot you cannot tell two sessions apart in the history. A distinct bot per session
buys that back; naming the bots after your handles makes the transcript read like your config.

What it does **not** cost is the presence roster. `parley_list_users` keys a peer by the handle each
presence beat *carries in its own payload*, falling back to the message sender only for a beat
emitted before that field existed — so sessions sharing one bot still appear as separate peers, each
under its configured `identity.handle`, and a hand-off addressed to a handle from a config file
resolves. This is a property of Zulip's sender model reaching only as far as the sender field: there
is no per-message sender override for a bot account, and none is needed for reachability.

## Retention (server-side, not configured by this plugin)

Zulip supports organization- and stream-level
[message retention policies](https://zulip.com/help/message-retention-policy) enforced by a
server-side deletion job — an admin setting, not something an unprivileged bot configures. As with
the other backends, expired history is simply gone from `fetchRecent` — no error signals it.

## Running a server

Use the canonical upstream setup — **[zulip/docker-zulip](https://github.com/zulip/docker-zulip)**
(or the [production installer](https://zulip.readthedocs.io/en/stable/production/install.html)).
For hacking, the [Zulip development environment](https://zulip.readthedocs.io/en/latest/development/overview.html)
listens on `:9991` — this plugin's default `site_url`. This package does not ship production infra.

### Behind a reverse proxy

Co-hosting a self-hosted Zulip behind the same reverse proxy as a remote Parley MCP has two
upstream-Zulip gotchas — see
[Zulip's reverse-proxy docs](https://zulip.readthedocs.io/en/stable/production/reverse-proxies.html):

- **Trust the proxy.** Zulip ignores `X-Forwarded-*` from untrusted sources, so it must be told
  the proxy's IP: `LOADBALANCER_IPS` (docker-zulip env) / `[loadbalancer] ips` in
  `/etc/zulip/zulip.conf` (installer). Across multiple Docker networks, `TRUST_GATEWAY_IP` alone
  may not cover the proxy's address as Zulip sees it — set `LOADBALANCER_IPS` to that IP/CIDR.
- **Reach it at its `EXTERNAL_HOST`.** Zulip validates the host, so requests must arrive as its
  configured `EXTERNAL_HOST`; in Docker, a network alias for that hostname is the simplest fix.
  Configure `EXTERNAL_HOST` rather than hand-widening host validation in custom settings.

## Tests

```
npx vitest run packages/bridge-zulip
```

The shared seam conformance suite (`@sharptrick/parley-conformance`) always runs against an
**in-process fake Zulip** (`test/fake-zulip.ts` — form-encoded-only, anchor-narrow reads,
long-polled event queues with heartbeats and a `gcQueues()` lever for the `BAD_EVENT_QUEUE_ID`
recovery test). Set `PARLEY_ZULIP_URL`, `PARLEY_ZULIP_EMAIL`, and `PARLEY_ZULIP_API_KEY`
(optionally `PARLEY_ZULIP_STREAM`, default `parley`) to additionally run the same suite against a
real server — fresh topics in the configured stream are free, so no cleanup is needed. Setting them
is a request, not a hint: if one is missing, or the configured server does not answer the probe,
the run FAILS naming what was wrong rather than skipping green.
