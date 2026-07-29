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
| `senderHandle` | the Slack **user/bot id of the poster** — the logical `identity` argument of `post` is NOT carried on the wire, so everything this bridge posts reads back as the one bot user (see *Multiple concurrent sessions*). An entry carrying neither `user` nor `bot_id` (some app/workflow posts) reads back as `unknown` |
| `mentions` | Slack's `<@U…>` / `<@U…\|label>` / `<!subteam^S…\|@team>` / `<!here>` markup, rewritten to the `@handle` form core parses — see *Mentions* |
| absent topic | `channel_not_found` (and `not_in_channel` on read) → the seam's `NoSuchTopicError`, i.e. "topic not present yet"; every other `ok:false` is a real error |

**Catch-up cost.** Slack pages history newest-first while the seam wants the oldest unseen page, so
a `fetchRecent({since})` walks to the oldest end of the backlog and returns only `limit` of it — and
the next call re-walks the remainder. Draining a backlog therefore costs about
`backlog² / (2 · limit · page)` requests in total (page = 200), which at Slack's tiered rate limits
is real wall-clock time after a long outage. Configure a **large `catchup.limit`** for Slack: the
aggregate cost falls linearly with it.

Threading is an approximation: `inReplyTo` becomes `thread_ts`. A plain thread reply does not
surface at channel level — `conversations.history` does not return it, and the live path **drops**
it for the same reason, so the two paths agree and nothing is delivered that a later catch-up could
not replay. It is durable but only visible inside the thread; a reply the author broadcasts to the
channel arrives as a `thread_broadcast` entry with its own `ts` and **is** surfaced — that is the
return path for replies to a threaded `post`.

**Mentions.** Slack never puts `@handle` on the wire; it serializes a mention as `<@U0ABC>`,
`<@U0ABC|label>`, `<!subteam^S0DEV|@team>` or `<!here>`. The plugin rewrites all four into the
`@handle` form core's mention parser reads, so `live_push.mention_filter` works. Map the ids that
matter to you with **`mention_map`** (Slack user/usergroup id → Parley handle); Slack's own label is
the fallback, and an unmapped, unlabelled id surfaces as the bare id — visible, but it will not match
a configured handle. Non-mention markup (`<!date^…>`, `<https://…|link>`, `<#C0…|general>`) is left
verbatim.

**Colliding topics fail fast.** Two topics that resolve to the same channel — both mapped in
`channel_map`, or one mapped and the other an unmapped channel-id literal — are rejected. A map
whose targets collide fails at `connect`; a collision that only appears when an unmapped literal is
used fails at first use, on **every** seam method (`post`, `fetchRecent` and `subscribe` alike, so a
reactive-only deployment with `live_push.enabled: false` is guarded too), naming both topics.
Folding them would silently drop one topic's subscription and deliver that channel's traffic under
the other topic's name.

**Rate-limit behaviour.** A 429 is retried with the server's `Retry-After` honoured **in full**:
only a backoff the bridge invents for itself is clamped, at `MAX_BACKOFF_MS` = 5 s. A stated hint
that would not fit the call's `DEFAULT_DEADLINE_MS` = 30 s budget ends the call naming the figure
rather than retrying sooner than Slack asked; a 429 with no usable hint waits
`DEFAULT_BACKOFF_MS` = 500 ms. All three constants live in `@sharptrick/parley-net-util`. If the
Socket Mode handshake fails, the long-poll path backs off before dialling `apps.connections.open`
again, so a core poll loop cannot turn one `fetch_recent` into hundreds of handshakes against
Slack's tightest limit; catch-up continues over HTTP in the meantime.

**Bounded waits.** A Socket Mode connection that opens and then says nothing is given
`handshake_timeout_ms` (default 10 s) to send `hello` before the attempt is abandoned, and a
blocking `fetchRecent` never waits longer than its own `block_ms` for that handshake. A
`conversations.history` walk stops with a named error if the server repeats a page cursor or keeps
handing out new ones past 2000 pages, rather than paging forever.

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
  mention_map:                  # Slack user/usergroup id → Parley handle (see Mentions)
    U0PARLEY: "ctx-payments"
  handshake_timeout_ms: 10000   # default; how long a silent Socket Mode socket may withhold `hello`
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
