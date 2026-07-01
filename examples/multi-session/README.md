# Multi-session example: sharing one backend across many configs

A realistic Parley deployment isn't one config — it's **several**, all pointed at the same
backend: one `parley.config.yaml` per running Claude Code session (each its own handle, its own
topic subset, its own `live_push`), plus one more for the remote/chat OAuth server. This directory
has runnable examples of that shape for every backend, and — the point of this example — spells
out **which values must be identical across all of them, which must NOT be, and what breaks
(often silently) when you get it wrong.**

Each subdirectory (`sqlite/`, `redis/`, `nats/`, `matrix/`, `xmpp/`) has three configs:

- `code-agent-a.yaml`, `code-agent-b.yaml` — two concurrent Claude Code sessions
- `remote-chat.yaml` — the config the remote/chat OAuth server loads (see
  [`examples/self-host-remote`](../self-host-remote/README.md))

All three point at the **same backend deployment**, so they all see the same topics and history.

## The general split

| | Belongs to | Varies per config? |
|---|---|---|
| `instance_id`, `identity.handle`, `topics`, `catchup`, `live_push`, `permissions` | the running bridge instance | **Yes** — every session picks its own |
| `backend` (which plugin) | the shared deployment | **No** — every config talking to the same backend must agree |
| `backend_config` (`url`/`db_path`/`servers`/etc.) | the shared deployment | **Mostly no** — see the per-backend table below for the exceptions |

`instance_id` only needs to actually *differ* when two sessions share the same `identity.handle`
(it defaults to the handle) — see [`docs/CONVENTIONS.md`](../../docs/CONVENTIONS.md).

## Per-backend `backend_config` risk table

Legend: ✅ must match · ⚠️ hidden risk if it diverges · 🔀 must NOT match · — safe to differ.

### SQLite ([full README](../../packages/bridge-sqlite/README.md))

| Key | | Risk if it diverges |
|---|---|---|
| `db_path` | ✅⚠️ | **Silent split, not an error.** Two configs pointing at different paths — including the *same relative path launched from two different working directories* — just get two independent, mostly-empty-looking histories. Nothing ever complains. Prefer an **absolute path**. |
| `poll_interval_ms` | — | pure per-instance latency knob |
| `retention_days` | ⚠️ | **Global, not topic-scoped.** The prune query deletes from the whole shared file regardless of which topics *this* session subscribes to. Any one session with it set prunes history every other session depends on too. If configs disagree, the most aggressive value wins over time (deletes are irreversible). |

### Redis ([full README](../../packages/bridge-redis/README.md))

| Key | | Risk if it diverges |
|---|---|---|
| `url` | ✅ | obvious — different servers, no shared history, no error either way |
| `key_prefix` | ✅⚠️ | **Hidden.** Reads like cosmetic namespacing, but topic `"ctx-payments"` under prefix `parley:` is a completely different Redis key than under `app:` — a silent split with zero error, even though every other field (`topics`, etc.) looks consistent. |
| `block_ms` | — | per-instance `XREAD BLOCK` / shutdown-recheck timeout |
| `retention_days` | ⚠️ | Trimming rides on `XADD` to a **shared** stream — whichever writer's config has it set enforces it for every session touching that topic. Divergent values → inconsistent, most-aggressive-wins enforcement over time, not a per-session setting. |

### NATS ([full README](../../packages/bridge-nats/README.md))

| Key | | Risk if it diverges |
|---|---|---|
| `servers` | ✅ | obvious |
| `subject_prefix` / `stream_prefix` | ✅⚠️ | Same hidden risk as Redis's `key_prefix` — a mismatch silently maps "the same" topic to different subjects/streams. |
| `retention_days` | ⚠️ | **Locked in at stream creation**, not per-config. Whichever session's instance is first to touch a brand-new topic wins that topic's `max_age` *permanently* — every other config's value for that topic is silently never applied. Divergence here is a race, not a choice; keep it identical to make the race harmless. |

### Matrix ([full README](../../packages/bridge-matrix/README.md))

| Key | | Risk if it diverges |
|---|---|---|
| `homeserver_url` / `server_name` | ✅ | obvious |
| `shared_room` | ✅ | mismatched shared-room vs. per-topic-room mode → sessions look in different rooms for "the same" topic |
| `user` / `password` | 🔀 **should NOT match** | see callout below — this is the opposite of the general rule |
| `sync_timeout_ms` | — | per-instance long-poll timeout |

**The big one:** Matrix's `post()` **ignores** the seam's `identity` argument entirely (the code
literally does `void identity`) — the homeserver stamps `sender` from whichever account is logged
in via `user`/`password`. Give `agent-a` and `agent-b` the *same* Matrix `user`/`password` (as you
would for every other shared `backend_config` field) and **every message from both sessions shows
up as sent by the one Matrix account** — `identity.handle` has silently no effect on Matrix. If you
want per-session attribution, provision a **distinct Matrix account** (different `user`/`password`)
for each session, same idea as `instance_id`, just carried in the "wrong" config block.

### XMPP ([full README](../../packages/bridge-xmpp/README.md))

| Key | | Risk if it diverges |
|---|---|---|
| `service` / `domain` / `muc_service` | ✅ | obvious |
| `username` / `password` | ✅ (usually fine to share — see below) | |
| `nick` | 🔀 **must NOT match if set** | see callout below |

**The catch:** like Matrix, XMPP's `post()` ignores the seam's `identity` (`_identity` — unused) —
the actual sender is the MUC **nick**. Unlike Matrix, though, leaving `nick` **unset** is safe to
share: the plugin auto-generates a random one per connection (`${username}-${rand()}`), so sessions
sharing `username`/`password` still get distinct (if randomly-labeled) sender attribution for free.
The risk only appears if you pin `nick` to a fixed, human-readable value for one session and then
copy that same config to another — MUC requires unique nicknames per room, so the second session's
join **fails outright** (a real error, not a silent misattribution like Matrix). If you want stable,
readable nicks, give each session its own.

## Running one of these

Pick a backend's directory, bring up that backend (each backend README's own "Run it" section), and
point separate terminals at each config, e.g. for SQLite:

```bash
mkdir -p /var/lib/parley   # or edit db_path in the three sqlite/*.yaml to a path you can write to
node packages/bridge-sqlite/dist/cli.js --config examples/multi-session/sqlite/code-agent-a.yaml
node packages/bridge-sqlite/dist/cli.js --config examples/multi-session/sqlite/code-agent-b.yaml
```

Both point at the same absolute `db_path`; posting from one and calling `parley_fetch_recent` from
the other shows the same history. The remote/chat config is meant for
[`examples/self-host-remote`](../self-host-remote/README.md)'s `server.ts`.
