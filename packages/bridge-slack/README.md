# @sharptrick/parley-slack

Slack backend for [Parley](../../README.md) — a **hosted-SaaS** backend over the raw Web API
(`fetch`) + Socket Mode (`ws`), no Slack SDK. Implements the seam in
`packages/bridge-slack/src/index.ts`; adding it required **zero** `@sharptrick/parley-core` changes.

Positioning: unlike the self-hosted core backends (SQLite/Redis/Matrix/XMPP/NATS), Slack is a
hosted service — history durability, availability, and identity live under **Slack's** policy, not
yours. Notably, free-plan workspaces hide history older than ~90 days, so a reader offline longer
than the retention window silently gets fewer messages back on catch-up.

## Mapping

| Seam | Slack |
|---|---|
| topic | a channel id, via `channel_map`; an unmapped topic is used as a channel-id literal |
| `post` | `chat.postMessage {channel, text, thread_ts?}` |
| cursor / backendMsgId | the per-channel message `ts` (e.g. `1234567890.123456`) — unique and strictly increasing per channel; compared integer-wise (seconds, then suffix), **never** lexically or as a float |
| `fetchRecent({since})` | `conversations.history {oldest: since}` — `oldest` is EXCLUSIVE (we never set `inclusive`); pages arrive newest-first and are re-assembled ascending |
| `subscribe` | **Socket Mode**: one shared websocket per plugin instance (`apps.connections.open` → single-use `wss://` URL) — real Events API pushes, not a poll timer |
| `resolveIdentity` | handle with `@` → `users.lookupByEmail`; own bot name → `auth.test` user id; else passthrough |
| `senderHandle` | the Slack **user/bot id of the poster** — the logical `identity` argument of `post` is NOT carried on the wire, so everything this bridge posts reads back as the one bot user (see *Multiple concurrent sessions*) |
| absent topic | `channel_not_found` (and `not_in_channel` on read) → the seam's `NoSuchTopicError`, i.e. "topic not present yet"; every other `ok:false` is a real error |

**Catch-up cost.** Slack pages history newest-first while the seam wants the oldest unseen page, so
a `fetchRecent({since})` walks to the oldest end of the backlog and returns only `limit` of it — and
the next call re-walks the remainder. Draining a backlog therefore costs about
`backlog² / (2 · limit · page)` requests in total (page = 200), which at Slack's tiered rate limits
is real wall-clock time after a long outage. Configure a **large `catchup.limit`** for Slack: the
aggregate cost falls linearly with it.

Threading is an approximation: `inReplyTo` becomes `thread_ts`, and Slack thread replies don't
surface at channel level (history or channel events) unless broadcast — durable, but only visible
inside the thread.

**`fetch_recent` long-poll (`block_ms`).** `fetchRecent` accepts an optional `block_ms`: when
nothing is newer than `since`, the call holds up to `block_ms` for a new message before returning
(possibly empty), so a polling agent's token cost scales with messages, not wall-clock time. Slack
serves this natively off the Socket Mode event stream. Core caps the wait at `catchup.block_max_ms`
(default 60s); `0`/omit preserves the immediate-return catch-up semantics.

## Config (`backend_config`)

```yaml
backend_config:
  bot_token: "xoxb-…"           # Web API calls (post/history/identity) — from .env, never committed
  app_token: "xapp-…"           # Socket Mode only (apps.connections.open); needs connections:write
  api_url: "https://slack.com/api"   # default; tests point this at an in-process fake
  channel_map:                  # Parley topic → channel id; unmapped topics = channel-id literals
    ctx-payments: "C0123456789"
```

## App provisioning (pointers only — follow Slack's docs)

Create an app at [api.slack.com/apps](https://api.slack.com/apps), then:

- **Socket Mode**: ON; generate an app-level token with the `connections:write` scope (`xapp-…`).
- **Bot token scopes** (`xoxb-…`) — exactly the methods the plugin calls, nothing wider (a granted
  scope the code never uses only widens what a leaked `xoxb-` token can do):

  | Web API method | Scope it needs | Used by |
  |---|---|---|
  | `chat.postMessage` | `chat:write` | `post` |
  | `conversations.history` | `channels:history` | `fetchRecent` |
  | `users.lookupByEmail` | `users:read.email` (Slack grants it alongside `users:read`) | `resolveIdentity` |
  | `auth.test` | none (any token) | `resolveIdentity` |
  | `apps.connections.open` | app-level `connections:write` (the `xapp-…` token, not the bot token) | `subscribe` |

  The plugin lists nothing — no `conversations.list`, so **no `channels:read`**; topics are mapped
  to channel ids by config, not discovered.
- **Event Subscriptions**: enable, subscribe the bot to `message.channels`.
- Install to the workspace and **invite the bot** to each channel you map a topic to.

(Private channels/DMs would need the `groups:*`/`im:*` twins of the scopes above; the core mapping
targets public channels.)

## Multiple concurrent sessions (one `backend_config` per config file, same workspace)

A real deployment is several configs — one per Claude Code session plus one for the remote/chat
server — all pointed at the same workspace:

- **`bot_token` / `app_token`** — **give every session its own bot** (its own app, or at least its
  own bot user). Slack stamps the posting bot as the sender and `post` cannot override it, so
  sessions sharing one bot token are indistinguishable on read-back: their presence heartbeats all
  arrive as the same `senderHandle`, the roster collapses them into one phantom peer advertising
  whichever beat landed last, and hand-off by handle then targets the wrong instance. Socket Mode
  also allows only ~10 concurrent connections per app token; each plugin instance holds ONE, and
  every open socket receives **every** subscribed event and filters locally.
- **`presence.topic`** — must be mapped in `channel_map` to a real channel id (or presence
  disabled). The default `parley-presence` is not a channel id, so it resolves to a channel that
  does not exist and the roster stays empty.
- **`channel_map`** — the hidden splitter: the same topic mapped to different channel ids in two
  configs silently splits history in two. Keep the map identical everywhere.
- **`api_url`** — leave defaulted in production; it exists for tests.

## Conformance

```bash
npx vitest run packages/bridge-slack   # always green — runs against an in-process fake Slack
```

The suite runs against `test/fake-slack.ts`, an in-process fake that mirrors the load-bearing
contract: per-channel monotonic `ts`, newest-first paged history with exclusive `oldest`
(fixed 50-message pages, forcing real multi-page assembly), Socket Mode `hello`/ack flow, and
own-post echo. There is no CI suite against real Slack (no hermetic server to compose up); to
verify manually against a real workspace, provision an app as above and run a quick loop —
`connect` with your tokens, `subscribe` a mapped topic, `post`, and `fetchRecent` — the seam
calls are exactly the ones the conformance suite exercises.
