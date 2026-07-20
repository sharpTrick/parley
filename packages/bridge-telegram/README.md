# @sharptrick/parley-telegram

A [Parley](../../README.md) backend plugin that carries topics over the **Telegram Bot API**,
spoken to via raw HTTPS ([core.telegram.org/bots/api](https://core.telegram.org/bots/api)) with
the global `fetch` — **no SDK dependency**.

It implements the frozen seam (`connect / disconnect / subscribe / post / fetchRecent /
resolveIdentity`); adding it required **zero** changes to `@sharptrick/parley-core`.

> **Telegram is a hosted SaaS**, unlike the self-hosted core backends (SQLite/Redis/Matrix/
> XMPP/NATS): there is no server of yours to run or `dev-compose` recipe to point at — only a
> bot token issued by [@BotFather](https://core.telegram.org/bots#botfather). That shifts two
> contract lines, both spelled out below: **history** (no Bot API history endpoint → local
> observed-message store) and **concurrency** (one `getUpdates` consumer per token → exactly
> one bridge per bot token).

## Seam mapping

| Seam concept       | Telegram mapping |
| ------------------ | ---------------- |
| `connect(config)`  | No session to establish — store the token, load the observed-message store from `store_path`, start the single shared `getUpdates` long-poll loop. |
| topic → chat       | `chat_map[topic]` if present, else the topic string is used as the chat id **literal** (numeric id or `@channelusername`). One topic ↔ one chat. |
| `post`             | `POST /bot<token>/sendMessage` `{ chat_id, text, reply_to_message_id? }` → the returned message object is ingested into the local store immediately (own posts **never** arrive via `getUpdates`). `inReplyTo` that parses as `<chat>:<mid>` threads via `reply_to_message_id: mid`. |
| `backendMsgId`     | **Composite `<chat_id>:<message_id>`** — Telegram's `message_id` is only unique *per chat*, so the chat id is baked into the dedup key. |
| `cursor`           | **`String(message_id)`** — cursors are per-topic, a topic maps to exactly one chat, and per-chat `message_id`s are monotonically increasing. Exclusive-`since` is a **numeric** compare, never lexical. Zero cursor is `'0'`. |
| `fetchRecent`      | A pure query over the local observed-message store — no network call exists that could serve it (see **History limitations**). Ascending, exclusive `since`, default window = most recent `limit` (100). |
| `subscribe`        | Registers on the **one shared** `getUpdates` long-poll loop (`timeout=<poll_timeout_s>`, `offset` = confirmed `update_id + 1`). Watermark = current max `message_id` for the topic, taken synchronously **before** `subscribe` resolves; starts at the tail — history is owned by catch-up. Accepts both `message` and `channel_post` updates. `disconnect()` aborts the in-flight long-poll. |
| `resolveIdentity`  | The bot's own username (via memoized `getMe`) resolves to its numeric id; any other handle passes through as a name convention — the Bot API cannot look up arbitrary users. |

`senderHandle` ← `from.username ?? String(from.id)` (usernames are optional on Telegram; the
numeric id is the stable fallback; channel posts carry no `from`, so the chat id stands in).
`timestamp` ← `date` (informational only — never used for ordering or dedup).

**`fetch_recent` long-poll (`block_ms`).** `fetchRecent` accepts an optional `block_ms`: when
nothing is newer than `since`, the call holds up to `block_ms` for a new message before returning
(possibly empty), so a polling agent's token cost scales with messages, not wall-clock time.
Telegram serves this natively off the shared `getUpdates` loop's per-chat delivery — no second
consumer is opened (see the one-consumer-per-token rule below). Core caps the wait at
`catchup.block_max_ms` (default 60s); `0`/omit preserves the immediate-return catch-up semantics.

> **`post`'s `identity` argument is not used.** Telegram stamps the sender as the bot account
> behind the token — the same caveat as the Matrix plugin's login account. Per-session
> attribution requires a distinct bot token per session.

## History limitations (read this)

The Bot API exposes **no history endpoint** — a bot cannot ask Telegram for a chat's past
messages. This plugin therefore keeps a small append-only JSONL store (`store_path`) of every
message it has **observed**: its own sends (recorded from the `sendMessage` response) plus
everything delivered by `getUpdates`. Consequences:

- `fetchRecent` replays only what **this bridge has seen**. Messages from before the bot
  joined the chat, or from before the store file existed, **cannot be backfilled** — ever.
- The store is **per process**: point a fresh deployment at the old `store_path` to keep its
  observed history; a new path starts empty.
- Within the observed window the seam contract holds fully: stable ids, monotonic exclusive
  cursors, dedup across `getUpdates` backlog replays, cold-restart replay.

This is the one structural strain this backend puts on the seam's "durable, replayable
history" line (DESIGN §6). Telegram retains an unconfirmed `getUpdates` backlog for ~24h, so
messages that arrive while the bridge is briefly down are still caught up on reconnect — the
store's dedup makes the replay harmless.

## Config (`backend_config`)

| key              | default                    | meaning |
| ---------------- | -------------------------- | ------- |
| `token`          | _(none)_                   | Bot token from @BotFather. A **secret** — `.env`/`backend_config` only, never committed. |
| `api_url`        | `https://api.telegram.org` | Bot API base URL (override for tests or a [local Bot API server](https://core.telegram.org/bots/api#using-a-local-bot-api-server)). |
| `store_path`     | `parley-telegram.jsonl`    | Observed-message store (append-only JSONL). One file per bridge process. |
| `poll_timeout_s` | `25`                       | `getUpdates` long-poll timeout, in **seconds** (Telegram's unit). Latency/cost knob only. |
| `chat_map`       | _(empty)_                  | Parley topic → chat id. Unmapped topics are used as the chat id literal. |

## Provisioning a bot

Talk to [@BotFather](https://core.telegram.org/bots#botfather): `/newbot` → name + username →
it hands you the token. Add the bot to your group/channel; for it to see all group messages
(not just commands/mentions), disable privacy mode (`/setprivacy` → Disable). Chat ids for
`chat_map` are easiest to read off the first `getUpdates` batch after sending a message in
the chat.

## Multiple concurrent sessions (MANDATORY: one bridge per bot token)

Unlike SQLite (N processes on one DB file) or Redis (N clients on one server), **you cannot
point several Telegram bridges at the same bot token**:

- Telegram allows exactly **one `getUpdates` consumer per token** — a second concurrent
  poller gets HTTP 409 and steals/starves updates. The plugin retries 409s on a long delay,
  but a deployment doing this is misconfigured.
- The observed-message store is **one file per process** — `appendFileSync` interleaving from
  two processes is not supported, and each process's store would be missing the other's
  observations anyway.

This is why the conformance suite's multi-process-writes case is deliberately **skipped** for
this backend (`concurrentPost` is not provided — the scenario is structurally
unrepresentable). Run **exactly one telegram bridge per bot token**; for multiple Parley
sessions, provision one bot per session (which also restores per-session sender attribution)
or fan sessions out over a self-hosted backend and bridge Telegram once.

## Tests

```
npx vitest run packages/bridge-telegram
```

The shared seam conformance suite (`@sharptrick/parley-conformance`) runs against an
**in-process fake Bot API** (`test/fake-telegram.ts` — real long-poll parking, per-chat
`message_id` counters, `offset` acknowledgement, and faithfully *not* echoing the bot's own
sends as updates), so it always runs — no external service, no real token. An extra unit test
covers the foreign-message ingestion path and cold-restart store replay.
