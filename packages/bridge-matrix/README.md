# @sharptrick/parley-matrix

A [Parley](../../README.md) backend plugin that carries topics over a **Matrix** homeserver,
spoken to via the raw [Client–Server HTTP API](https://spec.matrix.org/latest/client-server-api/)
with the global `fetch` — **no SDK dependency**. Unencrypted rooms only.

It implements the frozen seam (`connect / disconnect / subscribe / post / fetchRecent /
resolveIdentity`); adding it required **zero** changes to `@sharptrick/parley-core`.

## Seam mapping

| Seam concept            | Matrix mapping |
| ----------------------- | -------------- |
| `connect(config)`       | `POST /_matrix/client/v3/login` (`m.login.password`) → keep `access_token` + `user_id`; sent as `Authorization: Bearer <token>`. |
| topic → room            | Canonical alias `#parley_<sanitizedTopic>:<server_name>`. `GET /directory/room/<alias>`, then join. Only the WRITE paths (`post`, `subscribe`) go on to `POST /createRoom` when that 404s (`preset: private_chat` → **`join_rule: invite`**, see below); the create/resolve race (`M_ROOM_IN_USE`) resolves the alias instead. Cached per topic. |
| `post`                  | `PUT /rooms/<room_id>/send/m.room.message/<txnId>` with `{ msgtype: "m.text", body, "app.parley.topic": <topic> }` → returns `event_id`. Unique `txnId` per send. `in_reply_to` is honored: it becomes `m.relates_to: { "m.in_reply_to": { event_id } }`, so a reply threads natively in Element. |
| `backendMsgId` = `cursor` | The Matrix **`event_id`** — globally unique and distinct; serves as both the dedup key and the order key. |
| `cursor` (second form)  | `@parley-stream:<pagination-token>` — minted **only** when a read found no message belonging to the topic (an empty or all-foreign window), so there is no `event_id` to name. It marks the timeline position the window was read AT; replaying it returns exactly what landed after. It is **opaque**: not an `event_id`, never passed to `/context`, and not comparable to one. These two are the only cursor forms the plugin emits. |
| `fetchRecent` (no `since`) | `GET /rooms/<room_id>/messages?dir=b&limit=N&filter={"types":["m.room.message"]}`, paged backwards until N **belonging** messages are collected (a raw page cap must never hide a topic sitting behind foreign-topic or reaction/membership traffic), then reversed to ascending. A topic whose room does not exist yet reads as an empty page — a read never provisions (see below). |
| `fetchRecent` (`since`) | Two branches by cursor form. An **`event_id`**: `GET /rooms/<room_id>/context/<since>?limit=0` → `end` token → forward paging. A **`@parley-stream:` token** (and the legacy `''` sentinel written by older read-state files): no `/context` at all — the token *is* the forward position. Both then `GET /rooms/<room_id>/messages?from=<pos>&dir=f&limit=N&filter={"types":["m.room.message"]}`, paged forward until N belonging messages are collected. `since` is made strictly **exclusive** (drop up to and including the cursor event). A `since` that no longer resolves (purged / retention-expired) degrades to the recent window rather than throwing. `nextCursor` advances past a **page-sized** block of foreign-topic traffic so it can never wedge; a shorter, all-foreign tail leaves the cursor where it was, so another topic's traffic does not move this one's. `block_ms` changes only how long the call waits, never which cursor it reports. |
| `subscribe`             | A filtered `/sync` long-poll loop. The initial `timeout=0` sync yields a `next_batch` that **skips history**; the loop then delivers each new `m.room.message` (including our own sends) in timeline order. `disconnect()` aborts the in-flight long-poll. A failing `/sync` (revoked token, kick, homeserver fault) is reported on stderr and retried with exponential backoff up to 30s — never a silent hot loop. |
| `resolveIdentity`       | `{ handle, backendRef: handle }` — the string-convention echo, not a directory lookup (`GET /_matrix/client/v3/profile/...` is never called); a production bridge would map handles to provisioned Matrix users. |

`senderHandle` ← `event.sender`, `content` ← `event.content.body`,
`timestamp` ← `new Date(event.origin_server_ts).toISOString()` (informational only — never used for
ordering or dedup).

**`fetch_recent` long-poll (`block_ms`).** `fetchRecent` accepts an optional `block_ms`: when
nothing is newer than `since`, the call holds up to `block_ms` for a new message before returning
(possibly empty), so a polling agent's token cost scales with messages, not wall-clock time. Matrix
serves this natively via a room-filtered `/sync` long-poll (bounded), reconciled through
`/messages`. Core caps the wait at `catchup.block_max_ms` (default 60s); `0`/omit preserves the
immediate-return catch-up semantics. Blocking engages only relative to a `since`, per the seam: a
`fetch_recent` with no `since` is the default recent window and returns at once, even on a topic
whose room does not exist yet.

**Reads never provision.** `post` and `subscribe` create a topic's room when the alias does not
resolve; `fetch_recent` does not — it returns an empty page with a replayable cursor and starts
working the moment a peer's `post` creates the room (with `block_ms`, it waits for that within the
budget). `fetch_recent`'s topic argument comes from the model, whose context is fed by untrusted
inbound messages, and the allowlist admits pattern matches — so a read that provisioned would let
inbound data spend Synapse's scarce per-user room-creation budget (see below) and starve the writes
that need it.

> **`post`'s `identity` argument (your config's `identity.handle`) is not used.** The homeserver
> stamps `sender` from whichever account is logged in (`user`/`password` below) — see "Multiple
> concurrent sessions" for why this matters.

## A note on room-creation rate limits (`shared_room`)

Synapse rate-limits **room creation** hard — empirically ~2-room burst per user, then ~1 room every
~45s — while message send / read / `/sync` are unthrottled. A conformance run needs ~7 fresh,
isolated topics, so a brand-new room per topic is infeasible for an **unprivileged login** under the
suite's 20s-per-test budget. A real Parley deployment runs the bridge as a **rate-limit-exempt
[application service](https://spec.matrix.org/latest/application-service-api/)**, where one room per
topic is the correct, idiomatic mapping — leave `shared_room` unset for that.

For tests (and other unprivileged/constrained deployments) the plugin accepts an optional
`shared_room` alias localpart: every topic then resolves to that **one** stable room, and topics are
isolated by the `app.parley.topic` content tag carried on each event (filtered on read **and** on
the live path). Because the room persists, runs do **zero** `createRoom` calls. The conformance
fixture uses this mode against a stable `#parley_conformance:parley.local`.

> **Security — `shared_room` is test-only.** The `app.parley.topic` tag is **untrusted,
> member-writable** event content: Matrix enforces no integrity on custom content keys, so any member
> of the shared room can forge the tag and post a message that lands in whatever topic it names —
> including the reserved presence topic (a forged well-formed record then enters the roster under the
> sender's own homeserver-stamped handle). Inbound data thus chooses the topic/allowlist bucket. So
> `shared_room` **MUST NOT** carry mutually-distrusting topics; use it only for test fixtures and
> rate-limited single-tenant deployments. **Production leaves `shared_room` unset**, giving one
> physically separate room per topic, where the tag is ignored and the room is the isolation boundary.

## Security — topic rooms are invite-only by default

The room alias is **deterministic** (`#parley_<sanitizedTopic>:<server_name>`) and therefore
guessable, and Synapse federates by default. Note that `visibility: 'private'` only hides a room
from the **room directory** — it does not restrict joins; the **join rule** does. So topic rooms are
created with `preset: private_chat` → `join_rule: invite`: an uninvited account cannot read a
topic's history, and cannot post messages that core would deliver into a live Claude Code session as
`<channel>` events (the prompt-injection surface DESIGN §14 says to minimize), nor inject peers into
the presence roster.

Bring the accounts you *do* want in via `invite`. Set `room_preset: public_chat` only when you
deliberately want a room anyone on the homeserver can join. Rooms that already exist are joined as
they are — this setting applies to rooms this plugin **creates**.

Matrix's third preset, `trusted_private_chat`, is deliberately **not accepted**: it gives every
invitee power level 100, so any of them could set `m.room.join_rules` to `public` and undo the
guarantee above. `connect()` refuses it — and any other value outside the table below — as a **load
error**, naming what it would cost.

A join this account is not admitted to **fails loudly**, naming the alias, the MXID and the fix —
it does not degrade into an opaque `M_FORBIDDEN` from a later `/send` or `/messages`, or into a
`/sync` that silently never yields the room.

## Config (`backend_config`)

| key                | default                  | meaning |
| ------------------ | ------------------------ | ------- |
| `homeserver_url`   | `http://127.0.0.1:8008`  | Homeserver base URL. |
| `user`             | `parley`                 | Login localpart. |
| `password`         | `parleypass`             | Login password. |
| `server_name`      | `parley.local`           | Used to build room aliases. |
| `sync_timeout_ms`  | `25000`                  | `/sync` long-poll timeout; a positive whole number of milliseconds (anything else is a load error). Unbounded above: each `/sync` gets a transport deadline of this plus a full 30s call budget, so raising it does not make the homeserver's own answer look like a timeout. It is also the cadence at which a blocking `fetch_recent` re-checks by itself, so a very large value slows the safety net that covers a `/sync` loop stuck in retry backoff. A small value does not turn that safety net into a request storm: every park sleeps at least 250ms, and a `/sync` that answers faster than it long-polled for is paced. |
| `shared_room`      | _(unset)_                | If set, all topics share this one room (see above). Production leaves this unset. `connect()` warns on stderr while it is set. |
| `room_preset`      | `private_chat`           | `preset` for rooms this plugin creates. The default gives `join_rule: invite`. `public_chat` opts back in to a world-joinable room (see below), and `connect()` warns on stderr while it is set. These are the only two accepted — any other value is a load error. |
| `invite`           | `[]`                     | MXIDs invited to rooms this plugin creates — how humans and other accounts get into an invite-only topic room. **Required** once a second account shares a topic; see "Multiple concurrent sessions". |

Secrets live in `backend_config` / `.env`, never in code. Every key above that widens the trust
boundary — the default password, `shared_room`, `room_preset: public_chat` — announces itself on
stderr from `connect()`, so an operator who copied a fixture config sees the risk without reading
this file. They are warnings, not load errors: each is a legitimate choice for a fixture or a
rate-limited deployment.

## Multiple concurrent sessions (one `backend_config` per config file, same homeserver)

A real deployment is several configs — one per Claude Code session plus one for the remote/chat
server — all pointed at the same homeserver. `homeserver_url`/`server_name`/`shared_room` must be
**identical** across every one of them, but **`user`/`password` are the one exception to that
rule** — they should each be **different**:

- **`homeserver_url` / `server_name`** — the obvious ones; a mismatch means different servers or
  broken room aliases.
- **`shared_room`** — must agree too: if one config sets it and another doesn't, sessions look in
  different rooms for "the same" topic.
- **`user` / `password` — should NOT match, unlike every other backend's credentials.** As noted
  above, `post()` ignores the seam's `identity` argument entirely — the homeserver stamps `sender`
  from whichever account is logged in here. Give every session the same Matrix account (as you
  would for SQLite's `db_path` or Redis's `url`) and **every message from every session shows up as
  sent by that one account** — `identity.handle` silently has no effect. If you want per-session
  attribution (so a transcript can tell `agent-a` and `agent-b` apart), provision a **distinct
  Matrix account per session** and put its `user`/`password` here — the same role `identity.handle`
  plays for SQLite/Redis/NATS, just carried in `backend_config` instead of the per-instance block.
- **`sync_timeout_ms`** is safe to vary per session.
- **`invite` — required as soon as `user` differs.** With the default `room_preset` every room this
  plugin creates has `join_rule: invite`, and whichever session posts to a shared topic first is the
  one that creates its room. So every *other* account that shares that topic must already be in the
  creating config's `invite` list, or that session's startup catch-up rejects with `M_FORBIDDEN` and
  its live path delivers nothing. Since you cannot know which session gets there first, list the
  peers on **every** config — that is what the shipped examples below do. (Rooms that already exist
  are joined as they are, so `invite` cannot repair a room somebody else created without you.)

Runnable multi-config examples (two Code sessions with distinct accounts + a remote/chat config,
all sharing one homeserver): [`examples/multi-session/matrix`](../../examples/multi-session/README.md).

## Retention (server-side, not configured by this plugin)

Unlike SQLite/Redis/NATS, message retention here isn't something an unprivileged bridge account
can turn on itself — it's a **homeserver** feature. Synapse supports a
[retention policy](https://element-hq.github.io/synapse/latest/message_retention_policies.html)
(a `retention` block in `homeserver.yaml` plus an optional per-room `m.room.retention` state event)
that a scheduled purge job enforces; running the actual purge additionally needs the **admin
API** (`purge_history`), which a normal `m.login.password` user does not have. If you want
Parley's Matrix history to expire, configure retention on the homeserver — this plugin has no
opinion on it and needs no changes either way. As with the other backends, an expired room's
history is just gone from `fetchRecent`/`messages` — no error signals it.

## Running a homeserver

Use the canonical upstream image — **[`matrixdotorg/synapse`](https://hub.docker.com/r/matrixdotorg/synapse)**
([element-hq/synapse](https://github.com/element-hq/synapse), setup docs:
<https://element-hq.github.io/synapse/latest/setup/installation.html>). A throwaway dev instance is
the standard recipe: generate config, register the `parley` user, expose `:8008`. This package does
not ship production infra.

## Tests

```
npx vitest run packages/bridge-matrix
```

The shared seam conformance suite (`@sharptrick/parley-conformance`) runs against this backend and skips
cleanly when no homeserver answers `GET /_matrix/client/versions`.

## E2EE later

This plugin deliberately uses the **raw C-S API** (unencrypted rooms) — the clean fit for a reactive
bridge with no extra dependency. End-to-end encryption (Olm/Megolm device management, key sharing)
is the one place where [`matrix-js-sdk`](https://github.com/matrix-org/matrix-js-sdk) earns its
weight; that would be the path for an encrypted-room variant.
