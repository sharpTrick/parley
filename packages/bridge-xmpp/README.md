# @parley/xmpp

XMPP MUC backend for [Parley](../../README.md). Implements the seam in
`packages/bridge-xmpp/src/index.ts`; adding it required **zero** `@parley/core` changes.

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
cd <repo-root> && npx vitest run packages/bridge-xmpp   # the shared @parley/conformance suite
```

`PARLEY_XMPP_SERVICE` / `PARLEY_XMPP_DOMAIN` / `PARLEY_XMPP_MUC` / `PARLEY_XMPP_USER` /
`PARLEY_XMPP_PASS` override the defaults; the suite skips itself if no server is reachable.
