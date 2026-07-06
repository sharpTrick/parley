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
| topic → room            | Canonical alias `#parley_<sanitizedTopic>:<server_name>`. `ensureRoom`: `GET /directory/room/<alias>`; on `404` `POST /createRoom` (`preset: public_chat`), then join. The create/resolve race (`M_ROOM_IN_USE`) resolves the alias instead. Cached per topic. |
| `post`                  | `PUT /rooms/<room_id>/send/m.room.message/<txnId>` with `{ msgtype: "m.text", body, "app.parley.topic": <topic> }` → returns `event_id`. Unique `txnId` per send. |
| `backendMsgId` = `cursor` | The Matrix **`event_id`** — globally unique and distinct; serves as both the dedup key and the order key. |
| `fetchRecent` (no `since`) | `GET /rooms/<room_id>/messages?dir=b&limit=N` → reverse to ascending. |
| `fetchRecent` (`since`) | `GET /rooms/<room_id>/context/<since>?limit=0` → `end` token → `GET /rooms/<room_id>/messages?from=<end>&dir=f&limit=N`. `since` is made strictly **exclusive** (drop up to and including the cursor event). |
| `subscribe`             | A filtered `/sync` long-poll loop. The initial `timeout=0` sync yields a `next_batch` that **skips history**; the loop then delivers each new `m.room.message` (including our own sends) in timeline order. `disconnect()` aborts the in-flight long-poll. |
| `resolveIdentity`       | `{ handle, backendRef: handle }` — string convention; a production bridge would map handles to provisioned Matrix users. |

`senderHandle` ← `event.sender`, `content` ← `event.content.body`,
`timestamp` ← `new Date(event.origin_server_ts).toISOString()` (informational only — never used for
ordering or dedup).

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

## Config (`backend_config`)

| key                | default                  | meaning |
| ------------------ | ------------------------ | ------- |
| `homeserver_url`   | `http://127.0.0.1:8008`  | Homeserver base URL. |
| `user`             | `parley`                 | Login localpart. |
| `password`         | `parleypass`             | Login password. |
| `server_name`      | `parley.local`           | Used to build room aliases. |
| `sync_timeout_ms`  | `25000`                  | `/sync` long-poll timeout. |
| `shared_room`      | _(unset)_                | If set, all topics share this one room (see above). Production leaves this unset. |

Secrets live in `backend_config` / `.env`, never in code.

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
