# @sharptrick/parley-discord

A [Parley](../../README.md) backend plugin that carries topics over **Discord** channels, spoken
to via the raw [REST v10 API](https://discord.com/developers/docs/reference) with the global
`fetch` plus a minimal [gateway](https://discord.com/developers/docs/events/gateway) websocket
subset (`ws`) — **no discord.js dependency**.

It implements the frozen seam (`connect / disconnect / subscribe / post / fetchRecent /
resolveIdentity`); adding it required **zero** changes to `@sharptrick/parley-core`.

> **Positioning: hosted SaaS.** Discord is a hosted SaaS, unlike the self-hosted core backends —
> history durability, availability, and identity live under **Discord's** policy, not yours.
> There is no server you run, no retention knob you own, and no export path this plugin can
> promise. Choose it when your humans already live in Discord; choose a self-hosted backend
> (SQLite/Redis/Matrix/XMPP/NATS) when the transcript itself must be under your control.

## Seam mapping

| Seam concept              | Discord mapping |
| ------------------------- | --------------- |
| `connect(config)`         | Stores config; auth is stateless per request (`Authorization: Bot <token>`). The gateway socket opens lazily on first `subscribe`. |
| topic → channel           | `channel_map[topic]` if present; otherwise the topic string is used **as a channel id literal** — the zero-config path when topics simply are channel ids. |
| `post`                    | `POST /channels/<id>/messages` `{ content, allowed_mentions, message_reference? }` → returns the message `id`. `inReplyTo` maps to `message_reference.message_id` (a native Discord reply). **Discord caps a message at 2000 characters** — counted in Unicode CODE POINTS, so astral text (emoji, CJK extensions) is measured the way Discord measures it and not at half the limit; a longer `content` is rejected up front with an error naming the limit and the actual length (the plugin never chunks — one post is one `backendMsgId`). |
| `backendMsgId` = `cursor` | The message **snowflake** id — time-ordered and strictly increasing per channel; serves as both the dedup key and the order key. Snowflakes are decimal strings and **not lexically comparable**; ordering is delegated to the API (core never compares cursors either). |
| `fetchRecent` (no `since`) | `GET /channels/<id>/messages?limit=N` (newest-first) → reverse to ascending. The API caps a page at 100, so a larger `limit` pages **backwards** with `before=` until it is satisfied or the channel head is reached — the window is never silently truncated to 100. |
| absent topic              | A channel Discord does not know (`10003 Unknown Channel`) makes `fetchRecent` reject with core's `NoSuchTopicError`, which core reads as "topic not present yet" (e.g. an empty `parley_list_users` roster). Every other non-2xx — including `50001 Missing Access`, where the channel exists but the bot cannot see it — stays a real failure. |
| `fetchRecent` (`since`)   | `GET /channels/<id>/messages?after=<since>&limit=n` — `after` is **exclusive** server-side; each newest-first page is reversed, and for `limit > 100` the plugin pages forward advancing `after` until filled or a short page. |
| `subscribe`               | **One shared gateway websocket** per plugin instance: HELLO → IDENTIFY (intents `GUILDS \| GUILD_MESSAGES \| MESSAGE_CONTENT`) → READY, then `MESSAGE_CREATE` dispatch per subscribed channel — including the bot's own sends. Starts at the tail; history is owned by catch-up. The channel is then checked once (`GET /channels/<id>`): an id Discord does not know becomes `NoSuchTopicError` (core skips the topic with a diagnostic), and one that can never carry push under this intent set — the bot cannot access it (`50001`), or its type is not one of 0/2/5/10/11/12/13 — is reported on stderr naming the channel and the reason, and that one subscription is dropped, instead of leaving a permanently idle bridge or failing core's attach for every other topic. A **transient** dial failure (stalled handshake, close before READY, or a failure of the `GET /gateway/bot` url lookup itself) does **not** fail `subscribe`: it is reported on stderr and joins the reconnect ladder, which re-resolves the gateway url on every attempt, because failing here would fail core's attach and take the REST half of the bridge down with it. Reconnect re-IDENTIFYs (no RESUME — the push gap is harmless; cursor catch-up reconciles) with backoff capped at `120s × gateway_dialers`, and the cap is only forgiven once a socket stays up a minute — sustained flapping therefore stays under Discord's 1000-IDENTIFY/24h quota, whose penalty is a **bot-token reset**. A terminal close (4004/4010–4014) stops the loop, is reported on stderr, and makes later gateway calls fail fast with the reason. |
| `resolveIdentity`         | `GET /users/@me` (memoized): our own bot handle resolves to its real user id; every other handle passes through as a string convention — Discord has **no global name → id lookup**. |

`senderHandle` ← `author.username`, `content` ← `content`, `timestamp` ← the message `timestamp`
(informational only — never used for ordering or dedup). Discord serializes a mention as `<@id>`
markup, never as `@handle` text, so the plugin rewrites it to `@username` using the payload's own
resolved `mentions[]` before core parses mentions — otherwise `Message.mentions` would hold raw
snowflakes and core's `mention_filter` would drop every message.

**`fetch_recent` long-poll (`block_ms`).** `fetchRecent` accepts an optional `block_ms`: when
nothing is newer than `since`, the call holds up to `block_ms` for a new message before returning
(possibly empty), so a polling agent's token cost scales with messages, not wall-clock time.
Discord serves this natively off the gateway `MESSAGE_CREATE` stream. Core caps the wait at
`catchup.block_max_ms` (default 60s); `0`/omit preserves the immediate-return catch-up semantics.

> **`post`'s `identity` argument (your config's `identity.handle`) is not used.** Discord stamps
> `author` from whichever bot token is configured — see "Multiple concurrent sessions".

## Config (`backend_config`)

| key           | default                       | meaning |
| ------------- | ----------------------------- | ------- |
| `token`       | _(unset)_                     | Bot token (secret — `.env`, never committed). |
| `api_url`     | `https://discord.com/api/v10` | REST base URL. Tests point this at an in-process fake. |
| `gateway_url` | _(unset)_                     | Gateway websocket URL override (tests/fakes). Default: resolved live via `GET /gateway/bot`. |
| `channel_map` | `{}`                          | Parley topic → channel id. Unmapped topics are used as channel ids directly. Targets must be **distinct** — two topics folding onto one channel is rejected at `connect()`, because one of them would otherwise lose its subscription silently. A topic used as a literal channel id that another topic already maps to is refused the same way, on every call that resolves it. |
| `handshake_timeout_ms` | `10000` | How long HELLO → IDENTIFY → READY may take before the socket is terminated and the attempt fails (the reconnect loop then retries with backoff). |
| `gateway_dialers` | `1` | How many bridge instances **share this bot token and open a gateway socket**. The 1000-IDENTIFY/24h quota is per **bot token**, not per process, so the reconnect ceiling is `120s × gateway_dialers` — see "Multiple concurrent sessions". |
| `allowed_mentions` | `{ parse: ["users"], replied_user: false }` | Mention scope of every `post`. The default lets a `<@id>` user mention ping and refuses `@everyone`/`@here`/role pings, because `post` content can be untrusted inbound text an agent relayed. Widen it (e.g. add `"roles"` or `"everyone"` to `parse`) only deliberately. |

> **Presence needs a real channel.** Core enables presence by default (`presence.enabled: true`,
> `presence.topic: parley-presence`), and on Discord a topic string **is a channel id** — so the
> out-of-the-box topic is not a channel that can exist. Either set `presence.enabled: false`, or
> point `presence.topic` at a real channel id (directly or through `channel_map`). Left as-is,
> heartbeats fail (the presence loop swallows it, by design) and `parley_list_users` reports an
> empty roster, because the topic is genuinely absent.

## Rate limits (429)

The retry loop is `@sharptrick/parley-net-util`'s, shared by every HTTP backend, and one cap does
not describe it. The plugin reads Discord's hint from the standard `Retry-After` header, falling
back to Discord's own `retry_after` body field (seconds, float):

| what the 429 carries | what the call does |
| -------------------- | ------------------ |
| no usable hint       | waits the shared default of **500 ms**. The **5000 ms** ceiling bounds only a backoff the client invented for itself. |
| a stated hint        | waits it **in full**, past 5000 ms when that is what Discord asked for. Retrying sooner than the vendor asked is what turns a rate limit into a ban. |
| a hint longer than the call's remaining budget (**30000 ms**) | the call **fails** with an error naming both numbers instead of sleeping past its budget. Nothing is retried. |

Discord's *global* rate limits routinely ask for longer than 30000 ms. When one lands, the tool
call comes back as an error in the model's context rather than parking the session — this plugin
does not expose a per-call deadline override, so the operator fix is to reduce the load on the bot
token (fewer concurrent bridge instances sharing it, or a token per session) rather than to wait
the limit out.

## Provisioning the bot (pointers, not infra)

Everything happens in the [Discord developer portal](https://discord.com/developers/applications) —
this package authors none of it:

1. Create an application → **Bot** → copy the **token** into `backend_config.token` (via `.env`).
2. On the same Bot page, toggle on the **MESSAGE CONTENT** privileged intent — without it,
   `MESSAGE_CREATE` events arrive with **empty `content`**.
3. Invite the bot to your server via the OAuth2 URL generator with the `bot` scope and
   permissions to **View Channels**, **Send Messages**, and **Read Message History** in the
   channels you'll map as topics.

> **Topics must be GUILD channels.** The intent set is `GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT`
> — no `DIRECT_MESSAGES` — so live push only reaches guild text (0), voice (2) and stage (13) text
> chat, announcements (5), and threads (10/11/12). `subscribe` checks the channel once and reports
> anything else **on stderr**, naming the channel and the reason, then drops that one subscription:
> a DM or group DM, a category, a forum or media container, a directory, a channel the bot cannot
> access (`50001`), or a channel type Discord adds later. The mistyped snowflake and the guild the
> bot was never invited to both land here rather than as an idle bridge with no error. It is a
> **diagnostic, not a rejection**, deliberately: core fails its whole attach on a `subscribe`
> rejection, so one mis-mapped topic would take catch-up and `post` down for every other topic. An
> id Discord does not know at all is the seam's absent topic (`NoSuchTopicError`), which core is
> built to skip one topic at a time.

## Multiple concurrent sessions (one `backend_config` per config file, same bot)

Any number of bridge instances — one per Claude Code session plus the remote/chat server — may
share a single bot: each `post` is an independent REST call, snowflake minting is Discord's and
globally consistent, and each instance holds its own gateway socket. The tradeoff: **every post
from every session is attributed to the bot identity** (`author` = the bot), because the seam's
`identity` argument cannot override the token's account. If per-session attribution in the
Discord transcript matters, provision a distinct application/bot token per session and put it in
that session's `backend_config` — the same role `identity.handle` plays for SQLite/Redis/NATS,
just carried in the token. `channel_map` must agree across configs that share topics;
`api_url`/`gateway_url` only ever vary for tests.

> **The IDENTIFY quota is per BOT TOKEN, not per process — set `gateway_dialers`.** Discord allows
> **1000 IDENTIFYs per 24h per bot token** and penalizes an overrun by **resetting the token**,
> which kills every Parley instance on it until a human re-provisions. One instance whose gateway is
> flapping re-dials at the ladder's ceiling, i.e. at most **720** times a day — so two or three
> instances sharing a token on the default `gateway_dialers: 1` can together exceed the quota.
> Set `gateway_dialers` to the number of push-enabled instances sharing the token (the ceiling
> becomes `120s × gateway_dialers`, and the fleet's total stays at 720/day however many there are).
> Instances that never open a gateway socket — no `subscribe`, no `block_ms` long-poll — cost
> nothing against it and need not be counted.

## Tests

```
npx vitest run packages/bridge-discord
```

The shared seam conformance suite (`@sharptrick/parley-conformance`) runs against an
**in-process fake** (`test/fake-discord.ts`) that speaks the same REST + gateway subset —
hermetic, no credentials, always on. The fake also speaks Discord's *failure* surface (unknown
channels, injectable statuses/headers/bodies, the 2000-character and 100-per-page caps), so the
error half of the plugin is exercised rather than assumed. To exercise a real server manually: put
a real `token` in `backend_config`, use a real channel id as the topic (or map one in
`channel_map`), and drive `post`/`fetchRecent`/`subscribe` from a scratch script — mind the rate
limits described below.
