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
| sender | the occupant nick (resource of `room@svc/nick`) |
| timestamp | `<delay stamp>` from MAM forwarded messages if present, else now (informational only) |

Archive ids are not lexically comparable, but core never compares cursors — the server's RSM
`<after>` defines "strictly after" and the MAM archive defines order.

> **`post`'s `identity` argument (your config's `identity.handle`) is not used.** The sender is the
> MUC occupant nick — see "Multiple concurrent sessions" for why this is usually fine, but not
> always.

### Notes / caveats

- **MAM is mandatory.** Without `mod_mam` + `mod_muc_mam` (Prosody) / `mod_mam` (ejabberd) the
  room has no archive and `fetchRecent` returns nothing. This backend's catch-up is MAM.
- **Room lifetime = durability.** A MUC room (and its MAM archive) lives only while it has an
  occupant; the last occupant leaving destroys a non-persistent room. The Parley bridge stays
  joined to every topic it serves, so rooms it serves never empty. For history that must survive
  a full bridge restart, configure the MUC service to default rooms **persistent**, or pre-create
  persistent rooms for your topics.
- **Cold-creation race.** When several instances join a brand-new room simultaneously, exactly one
  creates it (status 201) and the rest briefly get `item-not-found` until that creation commits.
  The creator unlocks the room (XEP-0045 "instant room" config submit) and joiners retry the
  transient condition, so concurrent cold-start is safe.
- **Unique nick per connection.** MUC nicks must be unique per room, so each connection defaults to
  a random nick; concurrent writers can share a room without collision.

## Config (`backend_config`)

```yaml
backend_config:
  service: "xmpp://127.0.0.1:5222"   # default
  domain: "parley.local"             # default (the user's host)
  muc_service: "muc.parley.local"    # default (rooms live here)
  username: "parley"                 # default
  password: "parleypass"             # default — keep secrets in .env, never commit
  # nick: optional; defaults to a unique per-connection value
```

## Multiple concurrent sessions (one `backend_config` per config file, same server)

A real deployment is several configs — one per Claude Code session plus one for the remote/chat
server — all pointed at the same XMPP server. `service`/`domain`/`muc_service` must be **identical**
across every one of them; `username`/`password` should usually match too, **but `nick` is the one
field that must NOT, if you set it at all**:

- **`service` / `domain` / `muc_service`** — the obvious ones.
- **`username` / `password`** — as noted above, `post()` ignores the seam's `identity`, so the
  actual sender is the MUC nick, not `identity.handle`. Unlike Matrix, though, sharing one XMPP
  account across sessions is usually **fine**: leaving `nick` unset (the default) auto-generates a
  random nick per connection, so every session still gets its own distinct sender for free even
  with the same login.
- **`nick` — must be unique per concurrent session if you set it.** Pin it to a fixed, readable
  value and copy that same config to a second concurrent session, and the second session's MUC
  join **fails outright** — unlike every other divergence risk on this page, this one is a loud
  error, not a silent split, because MUC requires unique nicknames per room. Leave it unset unless
  you need stable names, and if you do set it, give each session its own.

Runnable multi-config examples (two Code sessions + a remote/chat config, sharing one XMPP account
with auto-generated nicks): [`examples/multi-session/xmpp`](../../examples/multi-session/README.md).

## Retention (server-side, not configured by this plugin)

As with Matrix, retention here is a **server** feature, not something this plugin's account can
turn on itself — catch-up is a MAM query, so MAM's own archive-expiry setting is the retention
knob. Prosody's `mod_mam` has `archive_expires_after` (e.g. `"1w"`, `"1m"`, or `"never"` —
Prosody's own default is `"1w"`, so a Parley deployment that wants longer history must raise this
explicitly); ejabberd's `mod_mam` has an analogous `default_shaping`/archive-cleanup config. Set it
on the server if you want a retention window — this plugin has no opinion on it and needs no
changes either way. As with the other backends, once an archived message expires, `fetchRecent`
just returns less history, with no error signaling that anything was pruned.

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
