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
| topic | one MUC room `<sanitizedTopic>@<muc_service>` (default service `muc.parley.local`); auto-created by `post`/`subscribe`, never by `fetch_recent` |
| join | `<presence to='room/nick'>` with `<history maxstanzas='0'/>` — no replay; tracked + ensured before post/fetch/subscribe |
| `post` | `<message type='groupchat'><body/><origin-id id='<uuid>'/></message>`; resolves on the MUC's **reflection**, returning its `<stanza-id by='room' id='…'>` |
| cursor / backendMsgId | the `<stanza-id>` / MAM archive id (XEP-0359 / XEP-0313) — identical via live push and via catch-up |
| `fetchRecent({since})` | MAM query (`urn:xmpp:mam:2`) with RSM `<after>since</after>` (exclusive), paging forward up to `limit`; no `since` → the most recent `limit`, paging **backwards** with RSM `<before>` from the archive tail. Either way `limit` counts messages the seam carries, not archive rows — a tail made of subject changes or retractions does not shrink the window |
| `subscribe` | every reflected groupchat `<message>` carrying a room `<stanza-id>` → `handler` (incl. own posts), in archive order |
| admission | a stanza with **no `<body>`** — a subject change, a correction, a retraction, a chat state — is not a message on either path; an *empty* body is |
| `resolveIdentity` | name convention: `backendRef` is the MUC nick this connection was last **admitted** under — which is not always the one it asked for, since a nick-locking service rewrites it (status 210) and it is the rewritten name the archive carries. It matches the `senderHandle` of a post made **now, to a room entered under that nick**. Once the nick is settled — pinned by `nick`, taken from the first `post`, or reverted after a `conflict` — **every** handle resolves to it, because one occupant is one sender; before the first `post` it is the fold `post` would apply to this handle (`alice@corp.com` → `alice_corp.com-<hash>`). Occupancy is per room, so a room entered *before* a `conflict` revert keeps the sender it entered under and `backendRef` does not describe it (see "One nick per logical identity") |
| sender | the occupant nick (resource of `room@svc/nick`), which defaults to `identity.handle` |
| timestamp | the `<delay stamp>` the SERVER attested — MAM's `<forwarded>` envelope, or on the live path a `<delay from='room'>` the room itself added — else now. A `<delay>` naming any other entity, **or naming none at all** (XEP-0203's `from` is a SHOULD, so an omitted one attests nothing and a real MUC does reflect an occupant's un-attributed `<delay>` verbatim), is an occupant's own and is ignored, so a co-occupant cannot choose it (informational only) |

Archive ids are not lexically comparable, but core never compares cursors — the server's RSM
`<after>` defines "strictly after" and the MAM archive defines order.

**`fetch_recent` long-poll (`block_ms`).** `fetchRecent` accepts an optional `block_ms`: when
nothing is newer than `since`, the call holds up to `block_ms` for a new message before returning
(possibly empty), so a polling agent's token cost scales with messages, not wall-clock time. XMPP
serves this natively via a live MUC wait plus a MAM reconcile (with an archival-lag re-poll). Core
caps the wait at `catchup.block_max_ms` (default 60s); `0`/omit preserves the immediate-return
catch-up semantics. It changes only *when* the call returns: a `block_ms` fetch answers the same
window the same call answers without one — the newest `limit` when `since` is omitted, everything
strictly after it when it is not.

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
  "not an occupant", drops the room from its join cache, and re-joins subscribed rooms — catch-up-only
  rooms re-join on their next seam call. That re-entry is **deferred and backs off** (200 ms, doubling
  to 6.4 s at the last step, plus up to 200 ms of jitter), because the trigger is remote: a room that
  ends occupancy on every join — a moderation bot, a members-only toggle, a MUC service that is
  shutting down — would otherwise be re-joined as fast as the connection can send presence. After 6
  consecutive losses, each within a minute of the previous, the plugin logs one loud error and stops
  re-entering that room; live push for the topic stays dead until a `post` or `fetch_recent` enters it
  again.
- **Room lifetime = durability, and occupancy is not durable.** A *non-persistent* MUC room and
  its whole MAM archive are destroyed the moment the last occupant leaves — and occupancy is
  presence on one stream, so it ends at every disconnect, not only at shutdown: a network blip, a
  server restart or an auto-reconnect all empty the room, and no amount of re-joining brings the
  archive back. This plugin therefore asks for a **persistent** room in the config submit of the
  rooms it creates itself, which is what makes history survive a reconnect. Two cases it cannot
  cover: a room that already exists as non-persistent, and a MUC service that refuses the field
  (the plugin falls back to a plain "instant room" submit so the room still unlocks, and **logs a
  loud stderr error naming the room and the consequence** — the fallback is a degradation, not a
  success). For those,
  configure the MUC service to default rooms **persistent**, or pre-create persistent rooms for
  your topics. After a reconnect the plugin re-sends the join presence for every room it had
  entered — subscribed or catch-up-only — so push and post recover without waiting for a timeout.
- **A read never creates a room.** `post` and `subscribe` join, which auto-creates the room and asks
  for it to be persistent. `fetch_recent` does not: it probes the room's `disco#info` first and enters
  the room only if the server positively answers it. `item-not-found` — and equally an answer that
  settles nothing, such as `service-unavailable`, `remote-server-timeout` or an IQ that never comes
  back — returns an **empty page with the caller's own cursor** instead of provisioning anything, and
  says so once per room on stderr. A probe this bridge could not get an answer to is not permission to
  create the room it was asking about, so catch-up on that topic stays empty until the probe answers. Without that, a `post_topics` pattern with a wildcard in it would let an
  agent mint an unbounded number of persistent rooms and MAM archives on a shared server just by
  reading topic names that do not exist — and nothing here ever destroys one. Operators sharing a MUC
  service with other users should also set `restrict_room_creation` (Prosody) and pre-create the rooms
  for their topics.
- **Carriage returns do not survive a round trip.** XMPP bodies are XML character data, and XML 1.0
  §2.11 requires the *parser* to translate a literal CR (and CRLF) to a single LF before any
  application sees it — `post('a\rb')` reads back as `a\nb`. The escape that would survive it
  (`&#xD;`) has to be produced by the serializer, and `@xmpp/xml` does not emit it for text nodes, so
  this cannot be fixed inside this plugin: pre-encoding the character reference would only get the `&`
  escaped in turn. Every other byte round-trips exactly (the shared conformance suite pins newlines,
  tabs, surrounding spaces, astral emoji and combining sequences), and an ordinary XMPP client shows
  what an agent posted; an escape layer of our own would break both. Treat CR as **normalized to LF**,
  not preserved.
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
  instead, injectively, so they cannot collide. Neither fold truncates: a JID localpart and resource
  are capped at 1023 bytes, so a topic or `identity.handle` whose folded name would exceed that is
  refused with an error naming this plugin and the length — folding it shorter is what would make two
  of them collide.)
- **One nick per logical identity.** The occupant nick is `identity.handle`, folded to the JID
  resource charset. Two sessions with different handles therefore get different senders on a shared
  account; two with the same handle are the same sender, which is what "same handle" means. If the
  nick is already taken by someone else in the room, the join is answered `conflict` and the plugin
  logs a loud error and keeps posting under its provisional per-connection nick — the same way
  whichever seam call hit the conflict first. Rooms it had already entered under the other nick stay
  entered under it (occupancy is per room), so only the room that hit the conflict changes sender.
  Pin `nick` to a free name to resolve it permanently; a `conflict` on a **pinned** nick is a
  misconfiguration and fails the call instead.
- **One bridge is one sender.** A connection is a single MUC occupant, so the occupant nick is taken
  from the FIRST `post`'s `identity.handle` and a later `post` under a different handle is archived
  — and read back — under the first one. That collapse is reported once on stderr; run one bridge
  per handle, or pin `nick`, if two handles must stay distinct.
- **A nick the server rewrites is adopted.** A nick-locking deployment admits the join under a nick of
  its own choosing and says so with status 210. The occupant nick is tracked **per room** from that
  presence, so this bridge still recognises its own reflections (and reports the nick the room
  actually shows) rather than stalling every post until its reflection timeout.

## Config (`backend_config`)

```yaml
backend_config:
  service: "xmpp://127.0.0.1:5222"   # default; use xmpps:// (or wss://) for anything non-loopback
  domain: "parley.local"             # default (the user's host)
  muc_service: "muc.parley.local"    # default (rooms live here)
  username: "parley"                 # default
  password: "parleypass"             # default — keep secrets in .env, never commit
  # nick: optional; defaults to identity.handle (see "Multiple concurrent sessions")
  # mam_page: 200                    # default; RSM page size for catch-up paging
```

Every key is checked before the connection is opened, and an **unknown key is a load error** naming
the accepted set — a misspelled `muc_servce` would otherwise leave every room addressed at the
default MUC service and every join bouncing a condition that names nothing.

> **Use `xmpps://` off localhost.** `@xmpp/client`'s STARTTLS is *opportunistic* — it upgrades only a
> stream whose peer advertises the feature — and SASL PLAIN is always offered, so with `xmpp://` (or
> `ws://`) to a non-loopback host an on-path attacker that strips `<starttls/>` is handed
> `backend_config.password` in cleartext. A `service` with **no scheme at all** warns the same way:
> `@xmpp/resolve` answers that form by DNS-SRV, and its candidate list ends at a cleartext
> `xmpp://…:5222` it falls back to as soon as 5223 refuses. That configuration is not refused (a loopback dev server
> legitimately runs unencrypted, which is why the Prosody snippet below sets
> `allow_unencrypted_plain_auth`), but it warns loudly on stderr at connect.

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
