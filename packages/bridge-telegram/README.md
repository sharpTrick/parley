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
| `connect(config)`  | Verifies the token with `getMe` (**fails fast** — a missing/revoked token, a wrong `api_url`, or an upstream answering HTTP 2xx with `ok:false` rejects `connect` rather than coming up as a silent black hole; on this API the envelope decides, never the status), resolves every `chat_map` entry, loads the observed-message store from `store_path` *knowing which chats it serves*, then starts the single shared `getUpdates` long-poll loop. Connecting an already-connected instance is an error — one loop and one store per instance. |
| topic → chat       | `chat_map[topic]` if present, else the topic string is used as the chat id **literal**. Either way it must be a numeric id or `@channelusername` — anything else is rejected (Telegram answers 400 "chat not found"), never silently accepted as an empty topic. `@name` is resolved to its numeric id once via `getChat`, and **everything the plugin stores or routes is keyed by that numeric id**, so a chat named three different ways is one topic's worth of history no matter which seam call ran first. One topic ↔ one chat. |
| `post`             | `POST /bot<token>/sendMessage` `{ chat_id, text, reply_to_message_id? }` → the returned message object is ingested into the local store immediately (own posts **never** arrive via `getUpdates`). A send Telegram accepted that the store did **not** record — a full disk, a store whose descriptor a failed compaction could not reopen, a teardown mid-call — **rejects**, naming the `<chat>:<message_id>` that exists upstream and the `store_path` it is missing from, rather than resolving with a `backendMsgId` no `fetchRecent` will ever return. `inReplyTo` threads via `reply_to_message_id: mid` only when it is a `<chat>:<mid>` composite naming **this** chat (`message_id` is unique per chat, so a composite from another chat is ignored). |
| `backendMsgId`     | **Composite `<chat_id>:<message_id>`** — Telegram's `message_id` is only unique *per chat*, so the chat id is baked into the dedup key. |
| `cursor`           | **`<store identity>.<seq>`**, where `seq` is the store's own **observation sequence** — the order this bridge *saw* the message, not Telegram's `message_id`. A `message_id` is minted when the sender's message is accepted, so a message minted *before* one of our posts can be delivered *after* it and would sit forever below a cursor already issued; observation order is monotonic by construction. Exclusive-`since` is a **numeric** compare on the sequence, never lexical. The identity half is minted once per store **file** (the sequence is per file and restarts at 1), so a cursor from a store file this one did not inherit is refused however far this store's own sequence has since climbed — see **History limitations**. Zero cursor is `'0'`, accepted bare because it sits below every sequence any store can stamp; anything that is neither `'0'` nor `<16 hex>.<digits>` is rejected as a malformed cursor rather than answered with a permanently empty page. |
| `fetchRecent`      | A query over the local observed-message store: **no history endpoint is ever called**, because the Bot API has none (see **History limitations**). The one network cost is resolving an `@channelusername` topic to its numeric id — one memoized `getChat`, already paid during `connect` for every `chat_map` entry — so a topic named *only* by an `@name` literal can fail its **first** catch-up while Telegram is unreachable. Ascending **by observation order**, exclusive `since`, default window = most recent `limit` (100). |
| `subscribe`        | Registers on the **one shared** `getUpdates` long-poll loop (`timeout=<poll_timeout_s>`, `offset` = confirmed `update_id + 1`, and a watchdog that abandons and re-polls a request the server accepts but never answers). Watermark = current max **observation sequence** for the topic, taken synchronously **before** `subscribe` resolves; starts at the tail — history is owned by catch-up. Accepts both `message` and `channel_post` updates. `disconnect()` aborts the in-flight long-poll. |
| `resolveIdentity`  | The bot's own username (via memoized `getMe`) resolves to its numeric id; any other handle passes through as a name convention — the Bot API cannot look up arbitrary users. |

`senderHandle` ← `from.username ?? String(from.id)` (usernames are optional on Telegram; the
numeric id is the stable fallback; channel posts carry no `from`, so the chat id stands in).
`timestamp` ← `date` (informational only — never used for ordering or dedup).

`content` ← `text`, else the media `caption` (a captioned photo carries its caption verbatim —
it is never dropped), else a `[photo]`/`[sticker]`/`[document]`/… placeholder naming the payload
kind. Updates with none of these (service messages: joins, leaves, pins) are **not ingested** —
an agent is never handed a blank turn.

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
- It is **bounded**, on load and on every append: the newest `observed_retention_per_chat`
  (default 10000) records **per chat**, across at most `observed_max_chats` (default 1000)
  *unserved* chats **plus** the chats this bridge serves (below). Anything older is dropped and the
  file is compacted, so raise `observed_retention_per_chat` if you need `fetchRecent` to replay a
  deeper window. Size disk and RAM from `observed_retention_per_chat × (observed_max_chats +
  the number of topics you point at this bridge)`: `observed_max_chats` alone is **not** a bound on
  the total, because the served chats are exactly the ones it must not evict.
- The chat cap **never evicts a chat this bridge serves** — one a `chat_map` entry resolves to,
  or one a seam call has named — on load or at runtime. A new unserved chat displaces the least
  recently active *unserved* chat instead, so a bot added to a flood of groups cannot crowd out
  your own topics or starve them of admission. That protection is **written into the store file**,
  so a chat a seam call named in one run is still protected at the next load, before any seam call
  in the new process could have named it again. The one gap: a topic used as a **chat-id literal**
  is not known to the bridge until some seam call names it *for the first time ever*, so a flood
  arriving in that window can still displace it. **List the topics you care about in `chat_map`** —
  `connect` resolves those before the store is even opened, which closes the window entirely.
- Compaction replaces the file by **rename**, never in place: a crash or a full disk mid-compaction
  leaves the previous file intact rather than a truncated one. It writes through a temp file it
  **creates exclusively** and refuses to compact through anything already sitting at that path that is
  not a regular file, so a symlink planted in the store's directory cannot redirect the rewrite. And it
  is amortization, not durability: a compaction that fails is reported on stderr and retried later —
  never turned into a failed `append`, which would report a stored message as a lost one.
- **Dedup outlives retention.** Evicting a record does not make it re-admittable: the store keeps a
  bounded memory of recently evicted `<chat>:<message_id>` ids (sized on Telegram's redelivery
  window, *not* on `observed_retention_per_chat`), and a compaction carries that memory into the
  file it writes. So a redelivered message is refused even when retention — however narrow you set
  it — has already rolled past the record, instead of being re-admitted at a *fresh* cursor above
  the one your agent is holding.
- It is created **owner-only** (`0600`, in a `0700` directory it had to create), and a store file
  left world-readable by an earlier version is tightened on load with one line on stderr. It holds
  the plaintext of every message the bridge has seen.
- **A lost store file invalidates every outstanding cursor.** The cursor is this store's own
  observation sequence, and a fresh file restarts that sequence at 1 — while core's saved cursor
  (in its state directory, a different lifetime) still points at the old numbering. Each store file
  therefore carries a random **identity**, minted when it is created and baked into every cursor it
  issues, and `fetchRecent` refuses a `since` carrying anyone else's ("was issued by a different
  observed-message store") **however many new messages this store has since observed** — rather
  than answering with a permanently short page once its own sequence climbs back past the stale
  cursor. Restore the original `store_path`, or clear the saved cursor for the topic. This is why
  `store_path` defaults to an **absolute** path under the same state directory rather than to the
  working directory the MCP client happened to pick.
  The residual: a file **partially** rolled back — same identity, records missing from the tail —
  is caught only while its sequence has not yet been re-issued past the cursor you hold ("ahead of
  every message this store has observed"). Restore a store file whole, or not at all.
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
| `store_path`     | `$XDG_STATE_HOME/parley/telegram/observed.jsonl` (else `~/.local/state/…`) | Observed-message store (append-only JSONL). One file per bridge process; **absolute by default**, because a store file that goes missing invalidates every cursor issued from it (see **History limitations**). |
| `poll_timeout_s` | `25`                       | `getUpdates` long-poll timeout, in **seconds** (Telegram's unit). Latency/cost knob only; must be an integer in `[1, 50]`. `0` is Telegram's "short polling" and would flood your bot token, so it is a **load error**, not a setting. |
| `chat_map`       | _(empty)_                  | Parley topic → chat id (numeric or `@channelusername`). Unmapped topics are used as the chat id literal. |
| `observed_retention_per_chat` | `10000`       | Newest-N observed records kept **per chat**, enforced on load *and* on every append; the file is compacted when records are evicted. Bounds how deep `fetchRecent` can replay — see **History limitations**. A positive integer: an out-of-domain value is a load error rather than a silent fall back to the default. |
| `observed_retention_per_topic` | _(unset)_   | Deprecated spelling of `observed_retention_per_chat` — the bound is per chat, and `chat_map` can give one chat two topic names. Still honoured; the new key wins when both are set. |
| `observed_max_chats` | `1000`                 | Max **unserved** chats kept in the store; a positive integer, validated like the retention bound above. Chats this bridge serves (a `chat_map` entry, or a topic a seam call has named — a mark that is persisted with the store) are never evicted and are retained *on top of* this cap, so it bounds the chats anyone-can-add-the-bot traffic creates, not the store's total. Unserved chats displace each other least-recently-active first once the cap is reached. |

> **Presence needs a real chat id.** Core enables presence by default (`presence.enabled: true`,
> `presence.topic: parley-presence`), and on Telegram a topic string **is a chat id** — so the
> out-of-the-box topic is neither a numeric id nor an `@channelusername` and can never resolve.
> Either set `presence.enabled: false`, or point `presence.topic` at a real chat (directly, or
> through `chat_map`). Left as-is, every heartbeat fails (core's presence loop swallows it, by
> design) and `parley_list_users` reports an empty roster; the plugin writes one throttled stderr
> line per unresolvable topic so the failure is not completely silent.

## Provisioning a bot

Talk to [@BotFather](https://core.telegram.org/bots#botfather): `/newbot` → name + username →
it hands you the token. Add the bot to your group/channel; for it to see all group messages
(not just commands/mentions), disable privacy mode (`/setprivacy` → Disable). Chat ids for
`chat_map` are easiest to read off the first `getUpdates` batch after sending a message in
the chat.

If this bot has ever had a **webhook** registered, call
[`deleteWebhook`](https://core.telegram.org/bots/api#deletewebhook) before starting the bridge:
Telegram refuses `getUpdates` with HTTP 409 while a webhook is active, and that state never
clears on its own.

## Multiple concurrent sessions (MANDATORY: one bridge per bot token)

Unlike SQLite (N processes on one DB file) or Redis (N clients on one server), **you cannot
point several Telegram bridges at the same bot token**:

- Telegram allows exactly **one `getUpdates` consumer per token** — a second concurrent
  poller gets HTTP 409 and steals/starves updates. The plugin retries 409s on a long delay
  (the other poller may release the token) and writes Telegram's own description to stderr —
  read it, because **409 also means "a webhook is active"** (see *Provisioning a bot*), which
  never self-heals. Either way a deployment hitting 409 is misconfigured.
- A token or `api_url` the API rejects outright (401/403/404) fails `connect`, and the same
  statuses from the poll loop stop ingestion with a diagnostic on stderr rather than looping
  silently forever.
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
`message_id` counters, `offset` acknowledgement that *confirms and drops* consumed updates,
transport-level stalls, and faithfully *not* echoing the bot's own sends as updates), so it
always runs — no external service, no real token. Extra unit tests cover the foreign-message
ingestion path, cold-restart store replay, the store's retention guarantees, and recovery from
a long poll the server never answers.
