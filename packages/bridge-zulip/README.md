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
| `connect(config)`         | No session to establish — Zulip auth is per-request HTTP Basic (`email:api_key`). `connect` captures config; a bad URL/key surfaces on the first call. |
| topic → stream + topic    | ONE configured Zulip **stream** (default `parley`) carries all Parley traffic; each Parley topic is a Zulip **topic** within it. |
| `post`                    | `POST /api/v1/messages` (form-encoded — Zulip rejects JSON bodies) with `{ type: "stream", to: <stream>, topic, content }` → returns the new message `id`. |
| `backendMsgId` = `cursor` | The Zulip **message `id`** — a globally monotonic integer (hence per-topic monotonic); serves as both the dedup key and the order key. Zero cursor is `'0'`. |
| `fetchRecent` (no `since`)| `GET /api/v1/messages` narrowed to `<stream, topic>`, `anchor=newest&num_before=N` → the most recent window, ascending. |
| `fetchRecent` (`since`)   | `anchor=<since>&include_anchor=false&num_before=0&num_after=N` — the anchor itself is excluded, so `since` is strictly **exclusive** server-side. Zulip returns ascending by id; no client-side reordering. |
| `subscribe`               | `POST /api/v1/register` a `<stream, topic>`-narrowed message **event queue** (its birth IS the tail — only later sends enter it; awaited before subscribe resolves), then a `GET /api/v1/events` long-poll loop. Zulip delivers our own sends back to our own queue. Queues idle-GC after ~10 min → on `BAD_EVENT_QUEUE_ID` the loop re-registers and **gap-fills** the dead-queue window through the catch-up path, deduped by last delivered id. `disconnect()` aborts in-flight polls and best-effort deletes the queues. |
| `resolveIdentity`         | `GET /api/v1/users`, matched on `email` or `full_name` → `backendRef` = the Zulip `user_id`; miss (or error) degrades to `{ handle, backendRef: handle }`. |

`senderHandle` ← `message.sender_email`, `content` ← raw `message.content` (`apply_markdown=false`
everywhere — the bridge wants source text, not rendered HTML), `timestamp` ←
`new Date(message.timestamp * 1000).toISOString()` (informational only — never used for ordering
or dedup).

> **`post`'s `identity` argument (your config's `identity.handle`) is not used.** Zulip stamps the
> sender from the authenticated bot account — see "Multiple concurrent sessions". **`inReplyTo` is
> ignored too:** Zulip has no per-message reply parent; it threads *by topic*, and the topic is
> already Parley's addressing unit.

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
| `site_url`          | `http://127.0.0.1:9991`  | Zulip server base URL (docker-zulip dev default port). |
| `email`             | `parley-bot@localhost`   | Bot email for HTTP Basic auth. |
| `api_key`           | `parley-api-key`         | Bot API key for HTTP Basic auth. |
| `stream`            | `parley`                 | The one Zulip stream carrying all Parley topics. |
| `events_timeout_ms` | `25000`                  | Client-side cap on each `/events` long-poll before it is aborted and reissued (un-acked events survive). |

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
real server — fresh topics in the configured stream are free, so no cleanup is needed.
