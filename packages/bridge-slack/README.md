# @sharptrick/parley-slack

Slack backend for [Parley](../../README.md) — a **hosted-SaaS** backend over the raw Web API
(`fetch`) + Socket Mode (`ws`), no Slack SDK. Implements the seam in
`packages/bridge-slack/src/index.ts`; adding it required **zero** `@sharptrick/parley-core` changes.

Positioning: unlike the self-hosted core backends (SQLite/Redis/Matrix/XMPP/NATS), Slack is a
hosted service — history durability, availability, and identity live under **Slack's** policy, not
yours. Notably, free-plan workspaces hide history older than ~90 days, so a reader offline longer
than the retention window silently gets fewer messages back on catch-up.

## Mapping

| Seam | Slack |
|---|---|
| topic | a channel id, via `channel_map`; an unmapped topic is used as a channel-id literal |
| `post` | `chat.postMessage {channel, text, thread_ts?, reply_broadcast?}` |
| cursor / backendMsgId | the per-channel message `ts` (e.g. `1234567890.123456`) — unique and strictly increasing per channel; compared integer-wise (seconds, then suffix), **never** lexically or as a float |
| `fetchRecent({since})` | `conversations.history {oldest: since}` — `oldest` is EXCLUSIVE (we never set `inclusive`); pages arrive newest-first and are re-assembled ascending |
| `subscribe` | **Socket Mode**: one shared websocket per plugin instance (`apps.connections.open` → single-use `wss://` URL) — real Events API pushes, not a poll timer |
| `resolveIdentity` | handle with `@` → `users.lookupByEmail`; own bot name → `auth.test` user id; else passthrough |
| `senderHandle` | the poster's Slack **user/bot id, resolved through `mention_map`** — one configured mapping governs both the handle and the rewritten mention markup, so a mapped person is not two identities in agent context; an unmapped id surfaces as the bare id. The logical `identity` argument of `post` is NOT carried on the wire, so everything this bridge posts reads back as the one bot user (see *Multiple concurrent sessions*). An entry carrying neither `user` nor `bot_id` (some app/workflow posts) reads back as `unknown` |
| `mentions` | Slack's `<@U…>` / `<@U…\|label>` / `<!subteam^S…\|@team>` / `<!here>` markup, rewritten to the `@handle` form core parses — see *Mentions* |
| absent topic | `channel_not_found` (and `not_in_channel` on read) → the seam's `NoSuchTopicError`, i.e. "topic not present yet"; every other `ok:false` is a real error |

**Catch-up cost.** Slack pages history newest-first while the seam wants the oldest unseen page, so
a `fetchRecent({since})` walks to the oldest end of the backlog and returns only `limit` of it — and
the next call re-walks the remainder. Draining a backlog therefore costs about
`backlog² / (2 · limit · page)` requests in total (page = 200), which at Slack's tiered rate limits
is real wall-clock time after a long outage. Configure a **large `catchup.limit`** for Slack: the
aggregate cost falls linearly with it.

**…and the tier that decides whether that page figure is honoured.** The plugin asks for 200 objects
per `conversations.history` page, but Slack caps the page — and the request rate — by app type. An
**internal, customer-built app** (the one this README's provisioning section describes: created in
your own workspace, installed there, not distributed) keeps the classic allowance: up to 1000 objects
per request at 50+ requests/minute, so a 200-object page is served in full and the cost model above
holds. A **commercially distributed app that is not listed on the Slack Marketplace** is capped, for
apps created or newly installed since 2025-05-29, at **15 objects per request, one request per
minute** — the server silently returns 15 however large a `limit` you send. Under that tier the cost
model is off by more than an order of magnitude, "configure a large `catchup.limit`" stops being
useful advice, and draining a long backlog is effectively impossible rather than merely slow; run
Parley as an internal app, or get the app listed, if catch-up over a real backlog matters. (The plugin
never assumes it got what it asked for: every window and trim decision counts what a page actually
contained.)

Threading is an approximation: `inReplyTo` becomes `thread_ts` **and `reply_broadcast`**, so the
reply is filed in the thread *and* broadcast to the channel as a `thread_broadcast` entry under the
same `ts`. The broadcast is not decoration — it is what makes the write readable back. A *plain*
thread reply does not surface at channel level (`conversations.history` does not return one, and the
live path **drops** it for the same reason, so the two paths agree and nothing is delivered that a
later catch-up could not replay), which would leave `post` returning a `backendMsgId` for a message
no Parley reader could ever see. So a threaded `post` is visible in the channel, not only inside the
thread.

**Mentions.** Slack never puts `@handle` on the wire; it serializes a mention as `<@U0ABC>`,
`<@U0ABC|label>`, `<!subteam^S0DEV|@team>` or `<!here>`. The plugin rewrites all four into the
`@handle` form core's mention parser reads, so `live_push.mention_filter` works. Map the ids that
matter to you with **`mention_map`** (Slack user/usergroup id → Parley handle); Slack's own label is
the fallback, and an unmapped, unlabelled id surfaces as the bare id — visible, but it will not match
a configured handle. Non-mention markup (`<!date^…>`, `<https://…|link>`, `<#C0…|general>`) is left
verbatim.

A `mention_map` **value** must be a handle core's mention parser can produce — alphanumeric at both
ends, interior `.`, `_` and `-` only — and one that is not fails at `connect`, naming the key. Write
`ctx-payments`, not `@ctx-payments`, `the boss` or `_ops`: those are spliced into content as
`@@ctx-payments` / `@the boss` / `@_ops`, parse back as something else or as nothing at all, and a
bridge running `live_push.mention_filter` on that handle would then drop every message addressed to
it, in silence.

**Escaping, and why `post` cannot mention anyone.** Slack's `text` field is markup, and the sender
owns the escaping of `&`, `<` and `>`. Everything Parley relays is untrusted — an inbound Matrix or
Discord message, a prompt-injected agent turn — so `post` escapes all three: content carrying
`<!channel>`, `<!here>`, `<!everyone>` or `<@U0BOSS>` is delivered as **literal text**, never as a
workspace broadcast or a real mention. The read side decodes the same three entities (Slack returns
them escaped, including for text a human typed), so one `post` → `fetchRecent` round trip is the
identity and re-posting a message read out of Slack cannot compound the escaping. The consequence to
know: Parley cannot address a Slack user by native mention — write the `@handle` form and map it with
`mention_map` instead.

**Colliding topics fail fast.** Two topics that resolve to the same channel — both mapped in
`channel_map`, or one mapped and the other an unmapped channel-id literal — are rejected. A map
whose targets collide fails at `connect`; a collision that only appears when an unmapped literal is
used fails at first use, on **every** seam method (`post`, `fetchRecent` and `subscribe` alike, so a
reactive-only deployment with `live_push.enabled: false` is guarded too), naming both topics.
Folding them would silently drop one topic's subscription and deliver that channel's traffic under
the other topic's name.

**Rate-limit behaviour.** A 429 is retried with the server's `Retry-After` honoured **in full**:
only a backoff the bridge invents for itself is clamped, at `MAX_BACKOFF_MS` = 5 s. A stated hint
that would not fit the call's `DEFAULT_DEADLINE_MS` = 30 s budget ends the call naming the figure
rather than retrying sooner than Slack asked; a 429 with no usable hint waits
`DEFAULT_BACKOFF_MS` = 500 ms. All three constants live in `@sharptrick/parley-net-util`. A blocked
`fetchRecent` does **not** hand the call straight back for core to re-drive when the live stream is
not delivering: it holds the caller's `block_ms` and re-reads `conversations.history` on a capped
ladder that starts at `DIAL_BACKOFF_MS` = 500 ms and doubles to `MAX_DIAL_BACKOFF_MS` = 5 s, retrying
the handshake on the same rungs. That matters for latency, not only cost: the message is already
durable in history, so it is delivered on the **next rung** instead of being withheld until the
deadline — which at the default `block_max_ms` of 60 s would be a minute of silent delay per message.
The ladder runs whether or not the handshake lands, because a completed handshake is not proof the
stream serves: an app whose Event Subscriptions lack `message.channels`, or one whose `app_token` is
shared with a second process (see *Multiple concurrent sessions*), greets and then pushes nothing.
The reactive-only configuration is covered by the same ladder: with no `app_token` there is no
handshake to attempt, so history is polled and nothing is dialled. Each rung resumes from the
position the previous read walked to, so traffic above the caller's cursor that this backend does not
surface (channel joins, edits, thread replies) is paged through **once** rather than once per rung.
One blocked call therefore costs one walk over that backlog plus
about `4 + block_ms / MAX_DIAL_BACKOFF_MS` single-page reads — **16 reads and dials at the default 60 s** — rather
than one of each per poll interval. That count is **linear**, not logarithmic, in `block_ms` once the
ladder reaches its cap: raising `catchup.block_max_ms` to core's ceiling of five
minutes costs ~64 of each per blocked call. Both methods are separately rate-limited, and `conversations.history` is the tighter of the two.
Only the loss of an **established** connection starts a reconnect loop, and
only one such loop runs at a time; a handshake that never completed belongs to the caller that asked
for it, so a failure cannot fan out into parallel redial loops. That loop redials on the same ladder,
paced by how long the connection it lost actually **served**, not by whether the dial succeeded: a
connection that lasted less than `DIAL_BACKOFF_MS` advances the rung, and only one that outlived it
resets. An edge that accepts, greets and drops at once — a draining load balancer, an `app_token` at
its connection quota — answers every `apps.connections.open` with `ok:true` and so never touches a
failure ladder at all; without that rule it would be redialled at its own round-trip rate against
Slack's tightest-limit endpoint. The cost is that live push takes up to `MAX_DIAL_BACKOFF_MS` to come
back after such a spell; catch-up covers the gap.

**Bounded waits.** A Socket Mode connection that opens and then says nothing is given
`handshake_timeout_ms` (default 10 s) to send `hello` before the attempt is abandoned, and a
blocking `fetchRecent` never waits longer than its own `block_ms` for that handshake. A
`conversations.history` walk stops with a named error if the server repeats a page cursor or keeps
handing out new ones past 2000 pages, rather than paging forever.

That page ceiling is deliberately a **failure, not a truncation**: a walk resuming after a cursor
cannot publish a `nextCursor` it has not read down to without stepping over history nobody would ever
revisit. The consequence is that a topic whose backlog *above its stored cursor* exceeds
2000 pages (400k messages at a full 200-object page — ~30k on the reduced tier above) rejects every
catch-up with `exceeded 2000 pages` until the backlog shrinks, since the cursor cannot advance past
it. There is no in-band recovery: **reset that topic's cursor** in the bridge's read-state file to a
position inside the retained window, and catch-up resumes from there. Ordinary channels never reach
this; a firehose channel mapped to a topic that was offline for a long time can.

**`fetch_recent` long-poll (`block_ms`).** `fetchRecent` accepts an optional `block_ms`: when
nothing is newer than `since`, the call holds up to `block_ms` for a new message before returning
(possibly empty), so a polling agent's token cost scales with messages, not wall-clock time. Slack
serves this natively off the Socket Mode event stream. Core caps the wait at `catchup.block_max_ms`
(default 60s); `0`/omit preserves the immediate-return catch-up semantics.

## Config (`backend_config`)

```yaml
backend_config:
  bot_token: "xoxb-…"           # Web API calls (post/history/identity) — from .env, never committed
  app_token: "xapp-…"           # Socket Mode only (apps.connections.open); needs connections:write
  api_url: "https://slack.com/api"   # default; tests point this at an in-process fake
  channel_map:                  # Parley topic → channel id; unmapped topics = channel-id literals
    ctx-payments: "C0123456789"
  mention_map:                  # Slack user/usergroup id → Parley handle (see Mentions)
    U0PARLEY: "ctx-payments"
  handshake_timeout_ms: 10000   # default; how long a silent Socket Mode socket may withhold `hello`
  rotation_grace_ms: 10000      # default; how long a rotated-out socket may stay open once replaced
```

**What is checked at load, and what only warns.** `backend_config` is opaque to core, so this plugin
is the only layer that sees these values. `api_url` must be an http(s) URL, and every `_ms` knob must
be a positive whole number of milliseconds no larger than Node's timer range (`2147483647`) — past
that, `setTimeout` silently clamps the delay to 1 ms, so the bound the knob exists to set is the one
thing it cannot express. Both fail at `connect`, naming the key. A plaintext `http://` `api_url`
pointed at a **non-loopback** host is a legitimate fixture choice and is accepted, but it **warns**
at `connect`: every Web API call carries the `xoxb-` bot token across the network in the clear, and
`apps.connections.open` carries the `xapp-` app token the same way.

The websocket URL is **not** config — `apps.connections.open` hands it back — so it is held to the
same rule rather than trusted: a `ws://` URL to a non-loopback host is **refused** whenever `api_url`
is not itself plaintext-remote, because it would move the single-use Socket Mode ticket and every
workspace message onto the wire in the clear, to a host the operator never configured. Under a
plaintext `api_url` (the loopback fixture, or the recording proxy the warning above is about) a
`ws://` stream is no weaker than what is already configured, and is accepted.

## App provisioning (pointers only — follow Slack's docs)

Create an app at [api.slack.com/apps](https://api.slack.com/apps), then:

- **Socket Mode**: ON; generate an app-level token with the `connections:write` scope (`xapp-…`).
- **Bot token scopes** (`xoxb-…`) — exactly the methods the plugin calls, nothing wider (a granted
  scope the code never uses only widens what a leaked `xoxb-` token can do):

  | Web API method | Scope it needs | Used by |
  |---|---|---|
  | `chat.postMessage` | `chat:write` | `post` |
  | `conversations.history` | `channels:history` | `fetchRecent`, `subscribe` |
  | `users.lookupByEmail` | `users:read.email` (Slack grants it alongside `users:read`) | `resolveIdentity` |
  | `auth.test` | none (any token) | `resolveIdentity` |
  | `apps.connections.open` | app-level `connections:write` (the `xapp-…` token, not the bot token) | `subscribe`, `fetchRecent` |

  "Used by" is every seam method whose code path reaches the call, not the obvious one: `subscribe`
  probes `conversations.history` before it resolves (a channel the bot was never invited to would
  otherwise subscribe successfully and deliver nothing forever, so it fails closed on
  `channel_not_found`/`not_in_channel`), and a **blocking** `fetchRecent` dials
  `apps.connections.open` on its own ladder. So a missing scope surfaces on more seam methods than
  the method's name suggests.

  The plugin lists nothing — no `conversations.list`, so **no `channels:read`**; topics are mapped
  to channel ids by config, not discovered.
- **Event Subscriptions**: enable, subscribe the bot to `message.channels`.
- Install to the workspace and **invite the bot** to each channel you map a topic to.

(Private channels/DMs would need the `groups:*`/`im:*` twins of the scopes above; the core mapping
targets public channels.)

## Multiple concurrent sessions (one `backend_config` per config file, same workspace)

A real deployment is several configs — one per Claude Code session plus one for the remote/chat
server — all pointed at the same workspace:

- **`bot_token` / `app_token`** — **give every push-capable session its own Slack app** (its own
  `app_token`; a second bot user inside one app is **not** enough — see the routing note below).
  Slack stamps the posting bot as the sender and `post` cannot override it, so
  sessions sharing one bot token are indistinguishable on read-back: every session's messages arrive
  under the one bot id, so neither a human reading the channel nor an agent reasoning over
  `senderHandle` in its context can tell which session spoke. `parley_list_users` is **not** affected
  — a presence beat carries its emitter's handle inside the record and core keys the roster on that,
  with liveness scoped per random per-process instance id, so two sessions on one bot token still
  appear as two peers with their own topics. Socket Mode allows ~10 concurrent connections per app
  token and each plugin instance holds ONE, but the connections are **not** parallel copies of the
  stream: Slack routes each payload to **exactly one** of an app's open connections, with no
  guaranteed pattern. Two sessions sharing an `app_token` therefore each receive an arbitrary subset
  of the live pushes — silent, per-session live-path loss that only catch-up repairs (the blocking
  `fetch_recent` ladder above bounds how long it goes unnoticed).
- **`presence.topic`** — must be mapped in `channel_map` to a real channel id (or presence
  disabled). The default `parley-presence` is not a channel id, so it resolves to a channel that
  does not exist and the roster stays empty.
- **`channel_map`** — the hidden splitter: the same topic mapped to different channel ids in two
  configs silently splits history in two. Keep the map identical everywhere.
- **`api_url`** — leave defaulted in production; it exists for tests.

## Run it (CLI)

```bash
npm install && npm run build
parley-slack --config parley.config.yaml
# or: node packages/bridge-slack/dist/cli.js --config parley.config.yaml
# or: PARLEY_CONFIG=parley.config.yaml parley-slack
parley-slack --help      # also --version
```

`--config` (or `-c`, or `--config=<path>`) is the only argument. Anything else — a typo, a
`--config` whose value the shell ate — **exits 2 with a usage message** on stderr instead of falling
back to the default `parley.config.yaml`, since that default names a different deployment's another workspace's `bot_token` and `app_token`, its own `channel_map`, handle and topic allowlist.
`--help`/`--version` answer on **stdout** and exit 0; both exit before any connection is opened.
Once it is serving, stdout is the JSON-RPC channel and every diagnostic goes to stderr.

## Conformance

```bash
npx vitest run packages/bridge-slack   # always green — runs against an in-process fake Slack
```

The suite runs against `test/fake-slack.ts`, an in-process fake that mirrors the load-bearing
contract: per-channel monotonic `ts`, newest-first paged history with exclusive `oldest`
(fixed 50-message pages, forcing real multi-page assembly), Socket Mode `hello`/ack flow, and
own-post echo. There is no CI suite against real Slack (no hermetic server to compose up); to
verify manually against a real workspace, provision an app as above and run a quick loop —
`connect` with your tokens, `subscribe` a mapped topic, `post`, and `fetchRecent` — the seam
calls are exactly the ones the conformance suite exercises.
