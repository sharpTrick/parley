# @sharptrick/parley-xmpp

XMPP MUC backend for [Parley](../../README.md). Implements the seam in
`packages/bridge-xmpp/src/index.ts`; adding it required **zero** `@sharptrick/parley-core` changes.

A topic maps to a [MUC](https://xmpp.org/extensions/xep-0045.html) room. The per-message
[XEP-0359](https://xmpp.org/extensions/xep-0359.html) **stanza-id** — which equals the
[XEP-0313 MAM](https://xmpp.org/extensions/xep-0313.html) archive id — is a stable,
server-assigned, per-room value used as BOTH `backendMsgId` (dedup key) and `cursor`
(order key). Catch-up is a MAM query, so **MAM must be enabled on the server** (see below).

## Mapping

| Seam | XMPP |
|---|---|
| topic | one MUC room `<sanitizedTopic>@<muc_service>` (default service `muc.parley.local`); auto-created on join |
| join | `<presence to='room/nick'>` with `<history maxstanzas='0'/>` — no replay; tracked + ensured before post/fetch/subscribe |
| `post` | `<message type='groupchat'><body/><origin-id id='<uuid>'/></message>`; resolves on the MUC's **reflection**, returning its `<stanza-id by='room' id='…'>` |
| cursor / backendMsgId | the `<stanza-id>` / MAM archive id (XEP-0359 / XEP-0313) — identical via live push and via catch-up |
| `fetchRecent({since})` | MAM query (`urn:xmpp:mam:2`) with RSM `<after>since</after>` (exclusive); no `since` → empty `<before/>` = last page; pages forward up to `limit` |
| `subscribe` | every reflected groupchat `<message>` carrying a room `<stanza-id>` → `handler` (incl. own posts), in archive order |
| `resolveIdentity` | string convention (handle = backendRef) |
| sender | the occupant nick (resource of `room@svc/nick`), which defaults to `identity.handle` |
| timestamp | `<delay stamp>` from MAM forwarded messages if present, else now (informational only) |

Archive ids are not lexically comparable, but core never compares cursors — the server's RSM
`<after>` defines "strictly after" and the MAM archive defines order.

**`fetch_recent` long-poll (`block_ms`).** `fetchRecent` accepts an optional `block_ms`: when
nothing is newer than `since`, the call holds up to `block_ms` for a new message before returning
(possibly empty), so a polling agent's token cost scales with messages, not wall-clock time. XMPP
serves this natively via a live MUC wait plus a MAM reconcile (with an archival-lag re-poll). Core
caps the wait at `catchup.block_max_ms` (default 60s); `0`/omit preserves the immediate-return
catch-up semantics.

> **`post`'s `identity` argument (your config's `identity.handle`) becomes the MUC occupant nick.**
> The sender of every archived message is that nick, and it is the key core's `parley_list_users`
> roster is built on — so unless you pin `nick` yourself, the first `post` takes `identity.handle`
> as this connection's nick and the bridge keeps one stable identity across restarts. See
> "Multiple concurrent sessions".

### Notes / caveats

- **MAM is mandatory, and checked.** Without `mod_mam` + `mod_muc_mam` (Prosody) / `mod_mam`
  (ejabberd) the room has no archive — and since the archive id is also the cursor and the
  post-reflection correlator, a MAM-less server makes `post` unresolvable and `subscribe` a silent
  no-op. The plugin therefore probes the room's `disco#info` for `urn:xmpp:mam:2` on its first join
  and fails every seam call with an error naming the modules to enable, rather than timing out. A
  server that answers disco but does not actually archive is caught on the next round trip: a
  reflection with no `<stanza-id>`, or a MAM query answered `service-unavailable` /
  `feature-not-implemented`, is reported the same way.
- **Occupancy is rebuilt however it is lost.** A reconnect is only one way this connection stops
  being an occupant: a kick (307), a ban (301), an affiliation change (321), a members-only switch
  (322), a MUC service shutdown (332), a room destroy, and a component restart that simply forgets
  us all end occupancy with the stream still up. The plugin watches for its own
  `<presence type='unavailable'>` (a nick change, status 303, excluded) and for a post bounced as
  "not an occupant", drops the room from its join cache, and re-joins subscribed rooms immediately
  — catch-up-only rooms re-join on their next seam call.
- **Room lifetime = durability, and occupancy is not durable.** A *non-persistent* MUC room and
  its whole MAM archive are destroyed the moment the last occupant leaves — and occupancy is
  presence on one stream, so it ends at every disconnect, not only at shutdown: a network blip, a
  server restart or an auto-reconnect all empty the room, and no amount of re-joining brings the
  archive back. This plugin therefore asks for a **persistent** room in the config submit of the
  rooms it creates itself, which is what makes history survive a reconnect. Two cases it cannot
  cover: a room that already exists as non-persistent, and a MUC service that refuses the field
  (the plugin falls back to a plain "instant room" submit so the room still unlocks). For those,
  configure the MUC service to default rooms **persistent**, or pre-create persistent rooms for
  your topics. After a reconnect the plugin re-sends the join presence for every room it had
  entered — subscribed or catch-up-only — so push and post recover without waiting for a timeout.
- **`post`'s `inReplyTo` is ignored.** The seam's optional reply parent is dropped: nothing this
  backend returns carries the relation back, so an XEP-0461 `<reply/>` would be write-only. A
  reply posts as an ordinary top-level message in the topic's room.
- **Cold-creation race.** When several instances join a brand-new room simultaneously, exactly one
  creates it (status 201) and the rest briefly get `item-not-found` until that creation commits.
  The creator unlocks the room (XEP-0045 §10.1.2 config submit) and joiners retry the transient
  condition, so concurrent cold-start is safe.
- **Content must be XML-legal.** XMPP is one long-lived XML document: a codepoint XML 1.0 forbids
  (a C0 control other than tab/newline/CR, a lone surrogate, U+FFFE/U+FFFF) is not a rejected
  message but the end of the stream, taking occupancy of every room on the connection with it.
  Every caller string this plugin serialises — `post` content, the `since` cursor, `nick`,
  `muc_service`, `domain`, `username` — is refused up front with an error naming the offending
  codepoint, rather than put on the wire. (`topic` and `identity` are folded to a legal charset
  instead, injectively, so they cannot collide.)
- **One nick per logical identity.** The occupant nick is `identity.handle`, folded to the JID
  resource charset. Two sessions with different handles therefore get different senders on a shared
  account; two with the same handle are the same sender, which is what "same handle" means. If the
  nick is already taken by someone else in the room, the plugin logs a loud error and keeps posting
  under its provisional nick — pin `nick` to a free name to resolve it permanently.

## Config (`backend_config`)

```yaml
backend_config:
  service: "xmpp://127.0.0.1:5222"   # default
  domain: "parley.local"             # default (the user's host)
  muc_service: "muc.parley.local"    # default (rooms live here)
  username: "parley"                 # default
  password: "parleypass"             # default — keep secrets in .env, never commit
  # nick: optional; defaults to identity.handle (see "Multiple concurrent sessions")
  # mam_page: 200                    # default; RSM page size for catch-up paging
```

## Multiple concurrent sessions (one `backend_config` per config file, same server)

A real deployment is several configs — one per Claude Code session plus one for the remote/chat
server — all pointed at the same XMPP server. `service`/`domain`/`muc_service` must be **identical**
across every one of them; `username`/`password` should usually match too, **but `nick` is the one
field that must NOT, if you set it at all**:

- **`service` / `domain` / `muc_service`** — the obvious ones.
- **`username` / `password`** — sharing one XMPP account across sessions is **fine**, unlike
  Matrix. The sender is the MUC nick, not the login, and with `nick` unset each session takes its
  own `identity.handle` as its nick — so distinct sessions stay distinct senders on one account,
  and each keeps the same sender across restarts.
- **`nick` — leave it unset.** Set, it must be unique per concurrent session and nothing enforces
  that for you: MUC's unique-nickname rule is scoped to the *bare JID*, so two sessions on the
  **same** account can occupy one room under one pinned nick from two resources with **no error at
  any point** — both join, both post, and every message from both is attributed to that single
  nick. A loud `conflict` error only appears when the two sessions use **different** accounts. The
  same silent merge happens if you give two sessions the same `identity.handle`, which is the
  honest reading of that config: they are one identity.

Runnable multi-config examples (two Code sessions + a remote/chat config, sharing one XMPP account
with per-handle nicks): [`examples/multi-session/xmpp`](../../examples/multi-session/README.md).

## Retention (server-side, not configured by this plugin)

As with Matrix, retention here is a **server** feature, not something this plugin's account can
turn on itself — catch-up is a MAM query, so MAM's own archive-expiry setting is the retention
knob. Prosody's `mod_mam` has `archive_expires_after` (e.g. `"1w"`, `"1m"`, or `"never"` —
Prosody's own default is `"1w"`, so a Parley deployment that wants longer history must raise this
explicitly); ejabberd's `mod_mam` has an analogous `default_shaping`/archive-cleanup config. Set it
on the server if you want a retention window — this plugin has no opinion on it and needs no
changes either way. Once an archived message expires, `fetchRecent` returns less history, with no
error signaling that anything was pruned — and if the *cursor itself* has expired out of the
window, the result is server-dependent: RSM (XEP-0059) says a server should answer
`item-not-found` for an `<after>` UID it does not hold, but Prosody's `mod_mam` ignores it and replays
the surviving archive from the beginning. Core's `backendMsgId` dedup absorbs the replay, but a
resume from a cursor older than the retention window can cost a full re-read of the archive; size
`archive_expires_after` above your longest expected bridge downtime.

## Run an XMPP server (with MAM)

Use a canonical upstream image — not authored here. The server must enable MAM for MUC.

**Prosody** ([official `prosody/prosody` image](https://hub.docker.com/r/prosody/prosody)) —
enable `mam` and `muc_mam`, allow room creation, and (for plaintext dev) `allow_unencrypted_plain_auth`:

```
modules_enabled = { "mam" }            -- per-user MAM
Component "muc.parley.local" "muc"
    modules_enabled = { "muc_mam" }    -- MUC archive (required for fetchRecent)
    restrict_room_creation = false
```

**ejabberd** ([official `ejabberd/ecs` image](https://hub.docker.com/r/ejabberd/ecs)) — enable
`mod_mam` (it covers MUC archives).

(or the maintainer dev harness: `examples/dev-compose/`.)

## Conformance

```bash
# bring up a Prosody/ejabberd with MAM + MUC (examples/dev-compose), then:
cd <repo-root> && npx vitest run packages/bridge-xmpp   # the shared @sharptrick/parley-conformance suite
```

`PARLEY_XMPP_SERVICE` / `PARLEY_XMPP_DOMAIN` / `PARLEY_XMPP_MUC` / `PARLEY_XMPP_USER` /
`PARLEY_XMPP_PASS` override the defaults; the suite skips itself if no server is reachable.
