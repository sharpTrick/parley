# DESIGN.md — Parley

> **Parley** — a transport-agnostic seam that connects humans, online chat bots, and coding
> agents through one small messaging interface. The same pluggable seam carries messages,
> shared context, and task hand-offs across a Claude chat session, a Claude Code session, and
> a human in a chat client — over whichever backend you choose (local SQLite, Redis, Matrix,
> NATS). The name (a *parley* = a conference between parties to reach understanding) names the
> experience: parties conferring on common ground, not the plumbing underneath.
>
> Package/repo/scope: `parley` (`@sharptrick/parley-core`, `@sharptrick/parley-matrix`, …).

---

## 1. Purpose

Let humans, chat bots, and coding agents participate in topic-organized conversations that
live on a **self-hosted messaging backend**, so context explored in one place (e.g. a Claude
chat session) can be handed off and acted on by a Claude Code session — or watched and joined
by a human in a normal chat client.

A participating instance can:

- **Receive** new messages in real time while running (live push, Code only).
- **Catch up** on messages it missed, per topic, on demand or at session start (chat + Code).
- **Post** back into a topic so its output is visible to humans and other instances.

The defining bet: the **hard, platform-independent half** (push delivery, catch-up,
routing, dedup) is written once, above a thin seam. Each backend is a small plugin
satisfying that seam. Adding a backend = implementing one interface.

---

## 2. Resolved constraints (read before building)

Settled facts about how Claude Code Channels works today. Do **not** re-litigate; build to
them.

1. **Two delivery paths, by design.**
   - *Live push* uses Claude Code's native **`claude/channel`** capability (`--channels`).
     It only reaches **already-running** sessions and retains **no history** — anything
     sent while a session is down is not delivered by this path.
   - *Catch-up* uses **standard MCP tools** backed by the messaging backend's own
     persistence. This is the durable path.
   - The backend — not the channel — is the source of truth and memory.

2. **Auth: claude.ai subscription only.** Channels requires a claude.ai login
   (Pro/Max/Team/Enterprise). API-key / Console auth is **not** supported for the channel
   path. Free tier is out of scope.

3. **Custom-channel preview gating.** Loading a self-built channel currently requires the
   `--dangerously-load-development-channels` flag (official channels are allowlisted during
   the research preview). This is a **README note**, not a release blocker — a motivated
   self-hoster adds the flag. Public "drop-in" status tracks Anthropic's GA.

4. **Spawn-on-unknown-handle is deferred (post-v1).** v1 does not launch new Code
   instances. This removes process-lifecycle, unattended-permission, and per-instance-auth
   complexity, and shrinks the security surface to "writes into an existing session."

5. **Permission posture (when live push lands).** Unattended sessions hit local permission
   prompts that pause silently and can't be cleared remotely. The escape hatch
   (`--dangerously-skip-permissions`) is a **documented, default-OFF config knob**, sandbox
   only. The earliest milestone (catch-up-only) does not need it.

---

## 3. Architecture

```
                       ┌──────────────────────────────────────────┐
                       │            Messaging Backend             │
                       │  (local SQLite/Redis, or self-hosted     │
                       │   Matrix / XMPP / NATS)                  │
                       │  topics · handles · history              │
                       └───────────────┬──────────────────────────┘
                                       │  (backend-native protocol)
                       ┌───────────────┴──────────────────────────┐
                       │           Backend Plugin                  │
                       │  implements the SEAM (§4): connect,       │
                       │  subscribe, post, fetchRecent, resolveId  │
                       └───────────────┬──────────────────────────┘
                                       │  normalized Message (§5)
                       ┌───────────────┴──────────────────────────┐
                       │              bridge-core                  │
                       │  Reactive role:  post + fetchRecent (MCP) │
                       │  Proactive role: subscribe → emit         │
                       │                  <channel> events  [push] │
                       │  dedup + ordering via cursor (§6)         │
                       │  reply fan-out (§7)                       │
                       └───────────────┬──────────────────────────┘
              ┌────────────────────────┴───────────────────────────┐
              │                                                     │
     ┌────────┴─────────┐                              ┌───────────┴────────┐
     │ Claude Code      │                              │ Claude chat        │
     │ post+fetchRecent │                              │ post+fetchRecent   │
     │ + live subscribe │                              │ (via skill conv.)  │
     └──────────────────┘                              └────────────────────┘
```

`bridge-core` is backend-agnostic and knows only the normalized Message and the seam.
Plugins know only their backend and the seam. Neither knows the other's internals.

---

## 4. The Seam (backend plugin interface)

A backend plugin MUST implement these capabilities. Reference language is **TypeScript**
(native to the Claude Code / MCP ecosystem). Signatures illustrative.

```ts
interface BackendPlugin {
  // 1. Establish / tear down the live connection to the backend.
  connect(config: BackendConfig): Promise<void>;
  disconnect(): Promise<void>;

  // 2. Register interest in a topic; handler fires per inbound message (live path).
  //    The plugin decides HOW handler is driven (poll loop / blocking event source);
  //    core decides WHAT happens (emit <channel> event). See §9.
  subscribe(topic: Topic, handler: (msg: Message) => void): Promise<void>;

  // 3. Write a message to a topic as a given identity. Single centralized write path.
  post(topic: Topic, identity: Handle, content: string,
       opts?: { inReplyTo?: BackendMsgId }): Promise<BackendMsgId>;

  // 4. Durable catch-up for ONE topic since a monotonic cursor (standard-MCP path).
  //    Called once per topic; core loops over N topics.
  fetchRecent(args: {
    topic: Topic;
    since?: Cursor;     // monotonic position (§6); omit = backend default window
    limit?: number;
  }): Promise<{ messages: Message[]; nextCursor: Cursor }>;

  // 5. Map a logical handle to a backend identity. Best-effort: a real account lookup where
  //    the backend supports one, or a string-format convention otherwise. (The shipped plugins
  //    currently use the convention echo; Zulip is the one that hits a real directory endpoint.)
  resolveIdentity(handle: Handle): Promise<BackendIdentity>;
}
```

**Notes**

- `Topic` is the single abstraction over Matrix room / XMPP MUC / NATS subject / local
  channel. There is no separate thread parameter; finer-grained sub-streams are expressed
  as their own `Topic` where a backend supports them — that is the plugin's business.
- A **handle does not imply an account.** Matrix/XMPP back it with a provisioned user/JID;
  NATS/local treat it as a name convention. The plugin decides.
- `subscribe` drives the live path (push). `fetchRecent` drives catch-up. `post` serves
  replies/output for both, and is the single place write-notifications are emitted.

---

## 5. Normalized Message

The single type crossing the seam in both directions. Everything above the seam speaks only
this.

```ts
interface Message {
  topic: Topic;              // logical topic
  senderHandle: Handle;      // logical sender
  content: string;           // message body (text; richer payloads are a future concern)
  timestamp: string;         // ISO 8601, informational only — NOT used for ordering
  backendMsgId: BackendMsgId;// stable backend-assigned unique id (dedup key)
  cursor: Cursor;            // monotonic position of THIS message within its topic (§6)
  mentions: Handle[];        // handles referenced in this message
}
```

`timestamp` is for humans. **Ordering and dedup use `cursor` / `backendMsgId`, never
timestamp** (clock skew and equal-timestamp ties make timestamps unsafe).

---

## 6. Cursor: dedup & ordering (baked into the seam)

The same logical message can arrive twice — once via live push, once via `fetchRecent`
(e.g. a session that briefly dropped and reconnected). To make this deterministic:

- Every backend MUST expose a **monotonic position per topic**, surfaced as `cursor` on each
  Message and as `nextCursor` from `fetchRecent`.
  - SQLite → `INTEGER PRIMARY KEY AUTOINCREMENT` / rowid (free monotonic sequence).
  - Redis → stream entry ID (`XADD` IDs are monotonic).
  - Matrix → per-room stream/sync token.
  - XMPP → MAM archive id.
  - NATS → JetStream sequence number.
  - Postgres → `BIGSERIAL` seq (per-topic advisory lock keeps seq order == commit order).
  - Zulip → message id (globally monotonic integer).
  - Discord → message snowflake (per-channel strictly increasing).
  - Telegram → per-chat `message_id`, replayed from a **local observed-message store** (the
    Bot API exposes no history endpoint — no pre-join backfill; see §12 v0.6 caveat).
  - Slack → per-channel message `ts` (compared integer-wise, never as float/lexical).
- The cursor is **opaque to core** and **keyed by `topic`**. The plugin decides the real
  granularity.
- `bridge-core` dedups on `backendMsgId` and orders on `cursor` within a topic.
- Catch-up is **cursor-based, not timestamp-based**: `fetchRecent({ since })` returns
  everything after the stored cursor and a `nextCursor` to persist.

Because correctness rests on the cursor, **any notify mechanism can be best-effort** — a
dropped or duplicated push is harmless; core reconciles against the store via `fetchRecent`.

---

## 7. Behavior decisions (resolved defaults)

- **Catch-up trigger.** By convention, an instance calls `fetchRecent` **on session start**
  for each configured topic, then on demand. This is a `CLAUDE.md` / skill convention, not
  core logic, but it is the intended default and must be documented.
- **Reply fan-out.** A reply goes back through the **live channel** (fast path) **and** is
  written to the **backend** via `post` so it lives in durable history for the next
  catch-up. Rule: *replies always write to the backend; the live channel is only the fast
  hop.* Otherwise the instance's own messages vanish on restart.
- **Live-push filtering.** The live path forwards **all** messages in subscribed topics;
  handle-mention is a **filter flag**, not a separate subscription. Filtering lives in one
  place in `bridge-core`.
- **Catch-up scope.** `fetchRecent` is **single-topic**; core loops once per configured
  topic. Handle-based catch-up = resolve handle → set of topics → loop.
- **Presence / liveness.** A bridge announces itself by posting `hello` / `heartbeat` /
  `goodbye` to **one shared presence topic** (`presence.topic`, default `parley-presence`), and
  each beat carries the instance's subscribed topics **plus its `post_topics` reach** (the regex
  sources it may post to but does not subscribe, §14). This is isolated from real topics: the
  presence topic is **never subscribed and never enters catch-up / dedup**, so heartbeats never
  surface as `<channel>` events or pollute durable history — and because it is a single stream, a
  human on a real chat backend mutes **one** topic instead of one per context. It is also
  **reserved**: no `post` / `fetch_recent` (nor any `post_topics` pattern, §14) may target it, so
  a peer cannot spoof the roster. The `parley_list_users` tool reconstructs "who is live" from
  `fetchRecent` over that one topic plus a TTL window — so it works **identically on every backend
  with no new seam method**, reports each instance's subscribed topics **and post reach**, and lists
  an idle instance that has never posted. Its default (unscoped) roster is **everyone you share a
  channel with in either direction** — peers subscribed to a topic *you* can post to, or whose
  advertised `post_topics` can reach a topic *you* subscribe to — so a freshly-onboarded agent on a
  unique topic still discovers the peers it can hand off to (advertised pattern sources are inbound,
  so they are compiled defensively, never enumerated). TTL reclaims crashed instances; `goodbye` is
  a best-effort fast-path.
  This is **Parley-participant liveness, not a human directory** — a human in a native chat client
  appears only once they send a real message. A reactive-only front door (the chat instance)
  cannot receive `<channel>` pushes and can set `presence.enabled: false` to stay silent. Powered
  above the seam by `post`/`fetchRecent`; knobs in §11 (`presence`). Keep `presence.topic`
  consistent across a deployment — bridges announcing on different presence topics cannot see each
  other.

---

## 8. Chat integration (one agnostic MCP, not a backend-specific one)

The Claude **chat** instance is a first-class consumer of the **same agnostic bridge MCP**,
using only the standard-MCP subset:

- It calls **`post`** to publish handoffs and **`fetchRecent`** to read recent context.
- It does **not** use live `subscribe` (chat cannot receive pushes).
- A **skill** carries chat-side conventions only — which topic to post a handoff to, how to
  format it, when to read context. The skill is documentation of usage, **not** a second
  integration.

Explicitly **do NOT** have the chat instance install a separate backend-specific (Matrix /
XMPP) MCP. A second write path would bypass the normalized Message shape (handle, cursor,
mentions) that catch-up relies on to dedupe and order, and would let chat and Code diverge
on the same backend. One seam, one write path: `post`.

The chat instance reaches the bridge via **remote HTTP mode** with an OAuth front door
(§10), not local stdio — it is the one long-lived public instance, separate from the
per-Code-session local bridges.

---

## 9. The dual-role server & how `subscribe` is driven

A channel-capable bridge server is **not** a passive request/response server. It runs two
concurrent roles in one process:

1. **Reactive (standard MCP).** Exposes `post` and `fetchRecent` as tools; answers when
   called. This is the catch-up/publish path. **Chat uses only this.**
2. **Proactive (channel).** On startup (with `--channels`), kicks off a background loop that
   watches the backend and **pushes `<channel>` events into the session unprompted**. No
   tool call triggers this; from Claude's view, messages simply arrive. **Code uses this.**

Role 2 is exactly the seam's `subscribe`. The plugin decides the *mechanism*; core provides
a single backend-agnostic handler that turns `Message → <channel>` event. Two mechanism
families:

- **Polling** (SQLite): the server runs a poll loop —
  `SELECT WHERE cursor > :lastSeen` per subscribed topic on an interval — normalizes new
  rows, invokes handler, advances `lastSeen`. Silent at the MCP-protocol level.
- **Event-driven / blocking** (Redis `XREAD BLOCK`, Matrix sync, XMPP PubSub, NATS subscribe):
  handler is driven by genuine backend events instead of a timer.

Because core's emit-to-channel handler is identical across mechanisms, **push developed
against polling exercises the same core path event-driven backends will later drive.**

### bridge-local-sqlite is polling-only (by deliberate choice)

SQLite's `subscribe` is implemented **purely by the per-topic poll loop** — no socket, no
notify bus, no broker. This is a deliberate simplification: a cross-process notify socket
would require a single bound broker plus stale-socket detection and broker failover/election
(a small distributed-systems problem), and the only payoff is lower latency. Since the cursor
already makes polling fully correct, that complexity buys nothing essential. So SQLite stays
dumb and dependency-free: poll, reconcile via cursor, done.

- **Event-driven push is introduced by `bridge-redis` (v0.3)**, the first backend that
  drives `subscribe` from a real blocking event source (`XREAD BLOCK`). That milestone
  inherits the job of proving the push path works against genuine events, not a timer.
- Poll interval (e.g. 500ms–2s) is a latency/cost knob on the SQLite plugin with **no
  correctness impact** — the cursor guarantees nothing is missed regardless of cadence.
- **Multi-process** (N sessions → N bridges on one host, §10) is safe with SQLite **WAL mode**
  (already specified) plus a busy-timeout/retry so simultaneous `post`s from different
  instances don't error. With UDS gone, that concurrent-write handling is the *only*
  multi-process concern for SQLite.

---

## 10. Deployment topology & remote / chat mode

### Two deployment modes, one codebase

The same bridge runs in either of two modes; the seam, backends, and normalized Message are
identical across both. Only a thin auth/transport layer differs.

- **Local stdio mode (Claude Code).** No OAuth. Rich local config. Full local access. Runs as
  a local stdio MCP server launched with the session (and `--channels` for push). Everything
  in v0.1.
- **Remote HTTP mode (Claude chat / web / mobile).** Public HTTP endpoint with an **OAuth
  front door**. Reactive-only (`post` + `fetchRecent`; chat cannot receive push). Added in
  v0.2.

### Per-session bridge model

**N Claude sessions → N bridge processes.** Each session runs its own bridge with its own
config (handle, topics, subscriptions). This is structural, not a preference:

- **Channel/push is intrinsically per-session.** A channel-capable server pushes `<channel>`
  events into the *one* session that launched it via `--channels`. It is not a shared network
  service that fans out to many sessions. So push-capable bridges **cannot** be shared — each
  Code session needs its own.
- **The chat remote-mode bridge is a separate, long-lived process** (public HTTP, OAuth,
  reactive-only), distinct from the ephemeral per-Code-session local-stdio bridges. On one
  host you might have: one remote-mode bridge for chat + one local-stdio bridge per active
  Code session.
- **Cursor / read-state is per-instance, not global.** Different sessions legitimately hold
  different read positions per topic. Never share cursor state across instances.

Multi-instance on one host is safe. For SQLite the only concern is concurrent DB access (WAL
mode + busy-timeout, §9). For network backends it's a non-issue — each bridge is just another
client connection, and the backend handles concurrency natively.

### Network backends decouple "where the bus lives" from "where the bridge runs"

With SQLite, bridge and database are co-located by construction (same host, same file). With a
network backend (Matrix / NATS / etc.) the messaging server can live **anywhere**; the bridge
only needs network reach to it. This is added value of the network plugins: multiple bridges
on multiple machines can share one bus, with all coordination happening in the messaging
server rather than on a local filesystem.

### Remote / chat mode: the OAuth front door

We do **not** publish a public shared MCP. We publish **instructions for the user to host
their own bridge** and connect it to chat. Each instance is **single-tenant** — it
authenticates exactly one owner.

- **Config stays server-side.** The rich config (backend, topics, handle, `backend_config`)
  lives in the bridge's own config, exactly as in local mode. Claude's connector UI only ever
  receives the **server URL + OAuth client id/secret**. Backend credentials are **never**
  pasted into Claude.
- **OAuth authenticates the owner to the bridge** — not the user to the messaging backend.
  The backend credential is server-side; OAuth (2.1 + PKCE) just proves "this is the owner of
  this instance," gated by user consent.
- **OAuth is mandatory, not a choice.** Claude's chat connector does **not** support static
  bearer tokens, URL-embedded tokens (`?token=`), or no-user machine-to-machine grants. So the
  "URL with baked-in credentials" shortcut is impossible; an OAuth front door is the only path
  for per-user data.
- **Turn-key via a library.** The exact provider/flow is intentionally unpinned — the only
  requirement is that it be turn-key for the self-hoster. Owner credential handoff to the
  server happens **locally** (CLI command, CLI stdin, or a localhost setup page) so no secret
  crosses the public internet at setup.
- **Public-exposure constraint.** Chat reaches the server from Anthropic's cloud, so in remote
  mode the bridge **must be internet-reachable**. Mitigate by documenting **Anthropic IP-range
  allowlisting**. This is the single biggest friction for the self-hosting audience — state it
  plainly in the README.
- **`mcp-remote` escape hatch (Desktop only).** A local stdio proxy can broker OAuth from the
  user's machine so the bridge need not be public — but it does **not** serve claude.ai
  web/mobile, so it's a documented option, not the baseline.
- **Bring-your-own-IdP variant (post-v1).** `auth.mode: oidc` in the config swaps the built-in
  AS for delegation to an external OIDC provider (e.g. Keycloak): Parley becomes a pure
  resource server (RFC 9728) that publishes resource metadata pointing at the IdP and validates
  its JWTs locally (issuer + audience always; configurable claim gates such as a required realm
  role restore the single-tenant posture). This changes **who hosts the AS**, not the
  OAuth-is-mandatory rule — see `docs/keycloak-integration.md`.

---

## 11. Configuration

A single config object drives the bridge; sane defaults everywhere. Illustrative:

```yaml
backend: local-sqlite      # local-sqlite | local-redis | matrix | xmpp | nats
identity:
  handle: "ctx-payments"   # this instance's logical handle
topics:                    # subscribe to / catch up on (one fetchRecent call each) — THE ALLOWLIST
  - "ctx-payments"
  - "ctx-payments-reviews"
post_topics:               # OPTIONAL extra topics allowed for post/fetch only, as full-match regexes
  - "ctx-payments-.*"      # (never subscribed/caught-up; the presence topic can never be matched)
catchup:
  on_start: true
  limit: 100
live_push:
  enabled: false           # Code only; chat leaves this off
  mention_filter: false    # true = only surface messages mentioning `handle`
presence:                  # announce hello/heartbeat/goodbye; powers parley_list_users (§7)
  enabled: true            # reactive-only front doors (chat) can set this false
  topic: "parley-presence" # ONE shared topic all bridges announce on; mute this one to hide presence
  heartbeat_ms: 600000     # 10 min — agents stay subscribed a long time
  ttl_ms: 1800000          # a handle is "live" if its last beat is within this window; default 3× heartbeat_ms
permissions:
  skip_permissions: false  # DANGEROUS; sandbox-only; default off
backend_config:            # opaque to core; passed to the plugin
  # local-sqlite:
  #   db_path: ...
  #   poll_interval_ms: 1000   # latency knob only; no correctness impact
  # local-redis:  { url }
  # matrix: { homeserver, user, access_token, ... }
  # xmpp:   { jid, password, muc_service, ... }
  # nats:   { servers, subject_prefix, jetstream: true, ... }
```

Identity/topic→backend mapping is **convention-based by default** (derive
room/subject/channel from handle/topic), overridable in `backend_config`.

---

## 12. Build order (scope cuts)

**v0.1 — `bridge-local-sqlite`, local stdio, catch-up + polling push. Seam-proving gate.**
- Seam, normalized Message, cursor engine, dedup/ordering.
- `fetchRecent` (catch-up), `post` (output/replies), `subscribe` via the **polling** loop,
  `<channel>` emit handler.
- `CLAUDE.md` catch-up-on-start convention; chat skill for `post`/`fetchRecent`.
- Proves the seam end to end with no message servers and no infra at all.
- **Channel gate:** verify the exact `<channel>` event schema and tool-registration details
  against current Claude Code docs (`/en/channels`, `/en/channels-reference`) **before**
  implementing the push half; do not work from summary. Test against the **fakechat**
  loopback first.

**v0.2 — Remote / chat mode (OAuth front door).**
- Same codebase deployed as a **remote HTTP** server with an OAuth front door, still SQLite
  underneath. Adds the auth/transport layer described in §10; the seam, backends, and
  normalized Message are untouched.
- Turn-key OAuth via a library (implementation/flow intentionally unpinned). Single-tenant:
  authenticates the one owner. Backend config stays server-side.
- Lands here (not after the network backends) because chat mode is **orthogonal to the
  backend** — an HTTP+OAuth skin over the same `post`/`fetchRecent` SQLite already exercises.
  v0.1 having proven the seam is the prerequisite, not a network backend.

**v0.3 — `bridge-redis` (first event-driven push backend).**
- Redis streams for durable cursor + native blocking push (`XADD`/`XRANGE`/`XREAD BLOCK`).
- **First backend to drive `subscribe` from real events** rather than a poll timer; inherits
  the job of proving the event-driven push path. Lower friction than a homeserver.
- Success criterion: adding it touches **only** the new plugin, never `bridge-core`.

**v0.4 — `bridge-matrix` (first external-network backend).**
- matrix-js-sdk; room→topic, sync token→cursor, sync loop→subscribe, history→fetchRecent.
- First true proof the seam isn't local-shaped. Also the first backend that can run on a
  **different machine** from the bridge (§10 decoupling).
- Infra: README points to the canonical upstream Synapse Docker setup (§15); not authored
  here. Maintainer dev/test instance lives in the shared `examples/` compose.

**v0.5 — `bridge-xmpp`, `bridge-nats`.**
- XMPP: MUC→topic, MAM→fetchRecent/cursor, PubSub→subscribe. README must note that **MAM
  must be enabled** on the server or catch-up won't work.
- NATS: subject→topic, JetStream seq→cursor, wildcard→subscribe. (TS is the one
  off-home-language backend here; `nats.js` covers publish/subscribe/seq-fetch fine.)
- Infra: READMEs point to canonical upstream Docker images (§15); not authored here.
- Same success criterion: new plugin only, core untouched.

**v0.6 — `bridge-postgres`, `bridge-zulip`, `bridge-discord`, `bridge-telegram`,
`bridge-slack`.**
- **Postgres** (self-hosted): `BIGSERIAL` seq→cursor, `LISTEN`/`NOTIFY`→subscribe (true push;
  notify payload is a hint — subscribers re-query from their last seq, so drops coalesce
  harmlessly per §6), senders table→resolveIdentity. `post` takes a per-topic advisory
  transaction lock so seq visibility order matches commit order. Slots between SQLite
  (local floor) and Redis (broker).
- **Zulip** (self-hosted): the closest native fit — stream+topic→topic (near 1:1; Zulip
  topics are mutable, so membership can drift if admins move messages), globally monotonic
  message id→cursor, narrowed event queue + `/events` long-poll→subscribe (queue GC recovered
  by re-register + cursor gap-fill), `GET /messages` anchor→fetchRecent.
- **Discord, Telegram, Slack** — the first **hosted SaaS** backends, unlike the self-hosted
  core set; history durability and identity live under the vendor's policy (positioning
  noted in each plugin's class JSDoc). Discord: channel→topic, snowflake→cursor, gateway
  websocket→subscribe, `?after=`→fetchRecent. Slack: channel→topic, per-channel `ts`→cursor,
  Socket Mode websocket→subscribe (every envelope acked before processing),
  `conversations.history` paging→fetchRecent. Telegram: chat→topic, per-chat
  `message_id`→cursor, `getUpdates` long-poll→subscribe (one poller per token — no
  multi-instance writers), **fetchRecent replays a local observed-message store** because the
  Bot API has no history endpoint — the one backend that structurally strains the
  durable-replayable-history line of the fit contract (no pre-join backfill, ever).
- Infra: Postgres/Zulip READMEs point to canonical upstream images (`postgres`,
  `zulip/docker-zulip`) per §15; SaaS backends need vendor app/bot provisioning, no infra.
- Same success criterion: new plugins only, core untouched.

**Deferred (post-v1):** spawn-on-unknown-handle, richer payloads (files/images),
multi-instance routing.

---

## 13. Repo layout (monorepo)

```
parley/
├── packages/
│   ├── bridge-core/          # seam, Message type, cursor/dedup, channel emit, reactive tools
│   │   ├── transport/        #   local-stdio + remote-HTTP transports
│   │   └── auth/             #   OAuth front door for remote mode (v0.2); absent in local mode
│   │                         # ZERO backend dependencies
│   ├── bridge-local-sqlite/  # v0.1 — zero-infra on-ramp; polling-only
│   ├── bridge-redis/         # v0.3 — first event-driven push; first networked local-ish backend
│   ├── bridge-matrix/        # v0.4 — first network backend (flagship external)
│   ├── bridge-xmpp/          # v0.5
│   ├── bridge-nats/          # v0.5
│   ├── bridge-postgres/      # v0.6 — self-hosted SQL; LISTEN/NOTIFY push
│   ├── bridge-zulip/         # v0.6 — self-hosted; closest native fit (streams+topics)
│   ├── bridge-discord/       # v0.6 — hosted SaaS; gateway push
│   ├── bridge-telegram/      # v0.6 — hosted SaaS; local observed store (no history API)
│   └── bridge-slack/         # v0.6 — hosted SaaS; Socket Mode push
├── examples/
│   ├── fakechat-loopback/    # local test harness for the channel path
│   ├── self-host-remote/     # reference deployment for remote/chat mode (public + OAuth)
│   └── dev-compose/          # maintainer-facing throwaway infra for network-backend tests
│                             # (Synapse / Prosody / NATS / Redis) — NOT a production recipe
├── skills/
│   └── chat-handoff/         # chat-side skill: post/fetchRecent conventions
├── DESIGN.md
├── CLAUDE.md
├── TASKS.md
├── LICENSE                   # MIT
└── README.md                 # description + tags (§18); dev-flag note (§2.3); self-host + remote setup
```

`bridge-core` is the published heart and must stay backend-free. Remote mode is a
**transport/auth layer inside core**, not a plugin — the seam and backends are identical in
local and remote mode. The local `bridge-local-sqlite` and networked `bridge-redis` implementations both satisfy the seam,
demonstrating core is genuinely backend-agnostic before any network backend exists. The
promise: *implement five methods, get a Claude bridge for your platform.*

---

## 14. Security (designed in, not bolted on)

- **Topic allowlist.** The bridge only subscribes to / catches up on an explicit list of
  topics (`topics`). No wildcard-everything by default. `post_topics` optionally extends
  **post/fetch only** with full-match regex patterns (for a chat instance posting to ad-hoc
  topics) — it never widens subscribe/catch-up/presence, which stay the explicit list. The
  presence topic is **reserved**: no pattern, however broad, makes it postable/fetchable, so a
  peer cannot spoof the presence roster.
- **Inbound is untrusted.** A backend message becomes agent context; treat it as untrusted
  input, never as privileged instruction. With spawn deferred, worst case is "writes into a
  live session," but the prompt-injection surface concentrates here — keep backends private
  and lock write access to known handles.
- **Secrets** (tokens, JIDs, NATS/Redis creds) live in `backend_config`, never in core,
  never committed. Document `.env` / secret handling in the README.
- **`skip_permissions` defaults OFF**, sandbox-only.
- **Remote mode (chat): single-tenant OAuth front door.** Each public instance authenticates
  exactly one owner via OAuth 2.1 + PKCE with user consent. Owner credential handoff to the
  server is **local** (CLI / stdin / localhost page) so no secret crosses the public internet
  at setup. Backend credentials never leave the server; Claude only ever holds a consented
  token.
- **Public exposure is minimized.** In remote mode the bridge must be internet-reachable;
  restrict inbound to **Anthropic's published IP range** (allowlist) rather than the open
  internet.

---

## 15. Infrastructure & Docker policy

We do **not** author or maintain production compose files for backends that already ship
canonical, upstream-maintained ones. Doing so would mean maintaining infra recipes we don't
control and implicitly vouching for setups that drift. Instead:

- **Each network-backend plugin README points to the canonical upstream Docker setup**, and
  the developer (or a Claude Code instance) stands it up. **Docker is the default.**
  - **Matrix** → official Synapse Docker image / `matrix-org/synapse` documented compose.
  - **NATS** → official `nats` image; JetStream is a single-flag enable.
  - **XMPP** → official Prosody or ejabberd image. **README must note MAM must be enabled**,
    or catch-up (`fetchRecent`) has no archive to read.
- **One maintainer-facing dev/test compose lives in `examples/`** — throwaway instances for
  CI and local development of the network backends. Framed as "how we test," not "how to
  run in production." This is the concrete thing a Code instance spins up while building.
- Local backends need no infra at all: `bridge-local-sqlite` is zero-dependency;
  `bridge-redis` needs only the official `redis` image (also referenced, not authored).

---

## 16. The niche Parley fills (and why not just use/extend an existing project)

### The niche, stated simply

**A very simple, backend-agnostic *seam* MCP that enables messages, shared context, and task
hand-off between three kinds of participant — humans, online chat bots, and coding agents —
over whichever messaging backend you choose.**

The whole identity of the project is the **seam as the product**: one small interface
(`connect / subscribe / post / fetchRecent / resolveIdentity`), and behind it any backend —
a zero-infra local store, a data store, a human-watchable federated chat, or a network
fabric. Pick the backend; the participants, topics, catch-up, and hand-off behave the same.

Three properties define the niche, and *the combination* is what's unclaimed:

1. **Backend-agnostic via a real seam** — not a point bridge to one platform. Swap SQLite for
   Redis for Matrix for NATS without touching the participants or core.
2. **Three participant classes in one bus** — humans (in a normal chat client), chat bots
   (Claude chat via remote/OAuth mode), and coding agents (Claude Code via channels). Most
   prior art does *one or two*, usually agent-to-agent only.
3. **Deliberately small and standalone** — a focused give-away, not a feature buried inside a
   platform. "Implement five methods, get a Parley backend for your transport."

### Why we did not just use or contribute to an existing project

We searched the space thoroughly (see §17). The pattern exists, but always in a shape that
doesn't fit the niche:

- **Point bridges (one backend).** Tools like `matrix-bridge` already connect Claude to a
  single chat backend (Matrix) and even enable agent↔human↔agent loops in a room — but they
  are hardcoded to one transport with no seam. Extending one would mean retrofitting an
  abstraction layer the project was never built around, and would still leave us tied to that
  maintainer's single-backend scope. Parley's *point* is the abstraction those tools lack.
- **Local agent buses (one paradigm, agent-only).** `Agent Bus MCP`, `agent-message-queue`,
  `claude-peers-mcp`, the "Message Bus" skill all do topic-keyed, cursor-based, SQLite/file
  messaging — i.e. essentially our v0.1 — but they are local-only, agent-to-agent, and not
  transport-agnostic. They validate the SQLite floor; none reaches the backend-diversity or
  human/chat-bot participation that is our reason to exist. Contributing wouldn't get us to a
  seam; it would make us a duplicate.
- **Monolithic platforms (seam buried inside).** `GoClaw` independently arrived at the same
  "seam" abstraction with pluggable channel adapters and a task board — strong validation
  that the design is right — but it's a multi-tenant agent gateway (50+ tools, RBAC, 3-tier
  memory). The seam is an internal detail, not an extractable standalone tool. We want the
  small thing, not to fork a platform to dig it out.
- **The pattern as theory/prior-art.** Academic MCP surveys describe exactly this as the
  Mediator / Observer pattern, and enterprise patents describe "message backplane adapters"
  and "pluggable communications channels" decades ago. This tells us the design is *sound and
  well-understood* — it does not give us a usable, modern, MCP-native, give-away tool.

So the gap is specifically a **standalone, MCP-native, backend-agnostic seam** for
human↔chat-bot↔coding-agent context hand-off. Every ingredient exists somewhere; the
focused unification does not. That is what Parley builds, and why neither adoption nor a
contribution to an existing project served the goal.

---

## 17. Prior art — attribution, worthy mentions, and references to study

These are the closest projects found during design research. Listed for **attribution**
(credit where the space was charted before us), as **worthy mentions** (alternatives a user
might legitimately prefer), and as **references** (read these before building the relevant
piece — they solve real sub-problems we will hit).

**Closest to our high ground (transport / human-watchable / cross-provider):**
- **`elkimek/matrix-bridge`** — E2EE Matrix bridge + MCP server for any AI coding agent;
  agent↔human↔agent collaboration in a Matrix room. *Reference for the Matrix plugin:* E2EE
  via vodozemac, TOFU device trust, mention handling (which Matrix lacks natively). The
  single most relevant prior implementation for `bridge-matrix`.

**Local / SQLite agent buses (our v0.1 floor; converged independently):**
- **Agent Bus MCP** (agentbusmcp.com) — topic-per-task, one cursor per peer, SQLite store,
  reconnect-and-resume, searchable history, no hosted service. Nearest twin to v0.1.
  *Reference for:* the cursor/catch-up model and SQLite schema.
- **`avivsinai/agent-message-queue` (AMQ)** — file-based (Maildir-style) local A2A messaging,
  thread continuity, cross-session routing, hand-off state; intentionally minimal, no server.
  *Reference for:* zero-infra delivery semantics and the "stay small" scoping discipline.
- **`claude-peers-mcp`** — local message bus exposing peer-to-peer messaging tools to multiple
  Claude Code instances. *Reference for:* peer registration and ad-hoc routing.
- **"Message Bus" Claude Code skill** — file-based message logging, worker heartbeats, atomic
  file locking, multi-phase deliberation. *Reference for:* multi-process file coordination.

**Monolithic platforms that contain the seam (validation + design reference):**
- **`nextlevelbuilder/goclaw` (GoClaw)** — multi-tenant agent gateway; explicitly a
  "Provider seam," pluggable channel adapters (Telegram/Discord/Slack), SQL-claimed task
  board. Strong independent validation of our core abstraction. *Reference for:* how to draw
  the provider/seam interface cleanly and keep the loop backend-unaware.
- **OpenBSP** — self-hosted WhatsApp API with first-class MCP, decoupling LLM from messaging
  backend. *Reference for:* swap-the-agent-without-touching-integration framing.

**Agent-interop / protocol bridges (adjacent, not overlapping):**
- **ACP-MCP Adapter** (i-am-bee) — exposes ACP agents as MCP resources/tools.
- **Coral Protocol** — open infrastructure connecting an "internet of agents."

**Infrastructure references (backend building blocks):**
- **NATS** — connector framework, `mcp-transport-nats`, NATS MCP servers (bmorphism,
  sinadarbouy). *Reference for:* subjects→topics, JetStream seq→cursor, the NATS plugin.
- **Redis** — `redis/agent-memory-server` (pluggable backend factory pattern), official
  `mcp-redis`. *Reference for:* streams as cursor + blocking push for `bridge-redis`.

**Theory / standards (sound-design evidence, not competition):**
- Academic: *Survey of LLM Agent Communication with MCP* (Mediator/Observer patterns for
  inter-agent messaging); *MCP Bridge* (LLM-agnostic proxy).
- Prior art: enterprise "message backplane adapter" / "pluggable communications channel"
  patents — the same seam pattern, decades old, in middleware.

> Maintenance note: this list is a snapshot from design-time research. New entrants appear
> constantly in this space; re-scan by *function* (not by name) before major milestones.

**Re-scan at v1 (2026-06-26).** Searched by function (transport-agnostic / backend-agnostic
agent messaging, pluggable-backend seam, A2A message bus). Findings: the **pluggable-backend
pattern has gone mainstream for agent *memory/state*** — Microsoft Agent Framework v1.0 ships a
pluggable memory architecture (Foundry / Mem0 / Redis / Neo4j / custom), and
`redis/agent-memory-server` offers a pluggable vector-DB factory — but these swap *memory stores*,
not *messaging transports*, and are framework-internal, not a standalone seam. Per-transport
**point** MCP servers remain single-backend (e.g. `bmorphism/nats-mcp-server` for NATS only). No
new entrant combines (1) a real backend-agnostic messaging **seam**, (2) human ↔ chat-bot ↔
coding-agent in one bus, and (3) a small standalone give-away. **Parley's niche (§16) is still
unclaimed.** Worth tracking: the memory-pluggability convergence validates the "implement an
interface, swap the backend" thesis in an adjacent domain.

---

## 18. Discoverability — function-based tags

Realistically Parley may only ever be found and used by us. But best-effort discoverability
costs little. Put these where search engines and registries look: GitHub repo **topics**, the
README's **first line / description**, `package.json` **keywords**, and the MCP registry entry.

The naming strategy deliberately put the *function keywords here* (in metadata) rather than in
the name (`parley`), so the evocative name and the searchable terms both do their job.

**GitHub topics / package keywords (function-first):**
`mcp`, `model-context-protocol`, `mcp-server`, `claude`, `claude-code`, `claude-channels`,
`agent-messaging`, `agent-to-agent`, `a2a`, `multi-agent`, `agent-coordination`,
`context-sharing`, `context-handoff`, `task-handoff`, `agent-handoff`, `message-bus`,
`message-queue`, `pub-sub`, `transport-agnostic`, `pluggable-backend`, `backend-agnostic`,
`matrix`, `nats`, `redis`, `xmpp`, `sqlite`, `postgres`, `zulip`, `discord`, `telegram`,
`slack`, `self-hosted`, `chat-to-code`,
`human-in-the-loop`, `inter-agent-communication`, `agent-bus`.

**README first-line / description (keyword-dense, human-readable):**
> Parley — a transport-agnostic MCP seam for messages, context sharing, and task hand-off
> between humans, chat bots, and coding agents. One pluggable interface; runs on local SQLite,
> Redis, Matrix, or NATS. Bridges Claude chat ↔ Claude Code via native channels.

**Phrases to seed in README prose** (the function-searches a real user would type):
"share context between Claude chat and Claude Code", "hand off a task to a coding agent",
"agent-to-agent messaging over Matrix/NATS", "self-hosted message bus for AI agents",
"backend-agnostic MCP messaging", "humans and agents in the same chat room".

---

## 19. Open items for review (non-blocking)

- [x] **Project name: `parley`** — locked. Propagates to package/repo/scope/channel id.
- [ ] (none blocking) — design is ready to hand to a Code instance; next artifacts are
      `CLAUDE.md` and `TASKS.md`.

**Resolved since earlier revisions:**
- Name is **Parley** (`@sharptrick/parley-*`).
- `bridge-redis` is a committed v0.3 backend (not optional) and is networked, not local-only;
  remote/chat mode is v0.2.
- Infra: no per-backend production compose files are authored here. Each network-backend
  plugin README points to the canonical upstream Docker setup (§15). One maintainer-facing
  dev/test compose lives in `examples/`. Docker is the default assumption.
