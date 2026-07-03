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
| `post`                    | `POST /channels/<id>/messages` `{ content, message_reference? }` → returns the message `id`. `inReplyTo` maps to `message_reference.message_id` (a native Discord reply). |
| `backendMsgId` = `cursor` | The message **snowflake** id — time-ordered and strictly increasing per channel; serves as both the dedup key and the order key. Snowflakes are decimal strings and **not lexically comparable**; ordering is delegated to the API (core never compares cursors either). |
| `fetchRecent` (no `since`) | `GET /channels/<id>/messages?limit=N` (newest-first) → reverse to ascending. The API caps a page at 100 — that cap is the default window. |
| `fetchRecent` (`since`)   | `GET /channels/<id>/messages?after=<since>&limit=n` — `after` is **exclusive** server-side; each newest-first page is reversed, and for `limit > 100` the plugin pages forward advancing `after` until filled or a short page. |
| `subscribe`               | **One shared gateway websocket** per plugin instance: HELLO → IDENTIFY (intents `GUILDS \| GUILD_MESSAGES \| MESSAGE_CONTENT`) → READY, then `MESSAGE_CREATE` dispatch per subscribed channel — including the bot's own sends. Starts at the tail; history is owned by catch-up. Reconnect re-IDENTIFYs (no RESUME — the push gap is harmless; cursor catch-up reconciles). |
| `resolveIdentity`         | `GET /users/@me` (memoized): our own bot handle resolves to its real user id; every other handle passes through as a string convention — Discord has **no global name → id lookup**. |

`senderHandle` ← `author.username`, `content` ← `content`, `timestamp` ← the message `timestamp`
(informational only — never used for ordering or dedup).

> **`post`'s `identity` argument (your config's `identity.handle`) is not used.** Discord stamps
> `author` from whichever bot token is configured — see "Multiple concurrent sessions".

## Config (`backend_config`)

| key           | default                       | meaning |
| ------------- | ----------------------------- | ------- |
| `token`       | _(unset)_                     | Bot token (secret — `.env`, never committed). |
| `api_url`     | `https://discord.com/api/v10` | REST base URL. Tests point this at an in-process fake. |
| `gateway_url` | _(unset)_                     | Gateway websocket URL override (tests/fakes). Default: resolved live via `GET /gateway/bot`. |
| `channel_map` | `{}`                          | Parley topic → channel id. Unmapped topics are used as channel ids directly. |

## Provisioning the bot (pointers, not infra)

Everything happens in the [Discord developer portal](https://discord.com/developers/applications) —
this package authors none of it:

1. Create an application → **Bot** → copy the **token** into `backend_config.token` (via `.env`).
2. On the same Bot page, toggle on the **MESSAGE CONTENT** privileged intent — without it,
   `MESSAGE_CREATE` events arrive with **empty `content`**.
3. Invite the bot to your server via the OAuth2 URL generator with the `bot` scope and
   permissions to **View Channels**, **Send Messages**, and **Read Message History** in the
   channels you'll map as topics.

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

## Tests

```
npx vitest run packages/bridge-discord
```

The shared seam conformance suite (`@sharptrick/parley-conformance`) runs against an
**in-process fake** (`test/fake-discord.ts`) that speaks the same REST + gateway subset —
hermetic, no credentials, always on. To exercise a real server manually: put a real `token` in
`backend_config`, use a real channel id as the topic (or map one in `channel_map`), and drive
`post`/`fetchRecent`/`subscribe` from a scratch script — mind Discord's rate limits (the plugin
honors `429 retry_after` automatically).
