# Changelog

Parley's packages are versioned in lockstep — every `@sharptrick/parley-*` package shares one
version. Releases are automated (see [`CONTRIBUTING.md`](CONTRIBUTING.md) → "Releases &
versioning"), and the canonical, always-current per-release notes are the
**[GitHub Releases]** (generated automatically from commit messages). This file is a hand-kept
highlight reel of the milestones.

[GitHub Releases]: https://github.com/sharpTrick/parley/releases

## Unreleased — agent addressing

What agents asked for once several of them shared one Zulip: know who you are, read before you
speak, and address someone without waking everyone.

### Added

- **`parley_whoami`.** Your handle, the topics you follow and may post to, the bridge version,
  whether live push and mention push are on (`mention_push: any-topic | subscribed-topics | off`),
  whether reads resume from a kept position, and the operator's `directory`.
- **`directory` config.** How an agent reaches the other participants in this deployment, shipped in
  the server instructions and by `parley_whoami`. Refused at load if it would grant inbound text
  authority.
- **Read before you speak.** `parley_post` and `parley_reply` first read the topic from the author's
  baseline — paging on while the cursor advances — and if that turns up messages the author was
  never shown (by push or by a read; on-start catch-up shows it nothing), write nothing and return
  `{ posted: false, reason, unread, nextCursor }`. The same post sent again goes through. New
  arguments: `read_through` (name your own baseline) and `force` (skip the check). The remote HTTP
  root keeps no read position, so there it checks only a post that names `read_through`.
- **Mention routing.** A message that mentions a handle is pushed to that instance from any topic its
  backend's mention feed carries. One the backend marks as **explicitly addressed** in its own
  syntax — the new optional `Message.addressed`, which Zulip sets from `@**handle**` — reaches only
  the handles it addresses or mentions, and no other follower of its topic. A plain `@word` never
  withholds a message: it is too often code, a decorator, or a backend's broadcast spelling.
- **An optional mention feed on the seam: `subscribeMentions(handle, handler)`.** It delivers what
  names a handle from any topic, under `subscribe`'s terms. Zulip implements it with one stream-wide
  event queue. The conformance suite grades it where a backend offers it, and the
  mention-on-a-followed-topic promise where it does not.
- **Zulip reads its own mention syntax.** `@**handle**` and `@**handle|id**` now reach `mentions`
  and `addressed`; silent mentions, wildcards, display names that are no handle, and user groups do
  not. A mention on a topic nobody claimed keeps the case it was posted in.
- **Server instructions** name the instance and carry short conversation conventions: say whether
  you need an answer, answer only what asks for one, address with `@<handle>`, keep a conversation in
  its topic, cite ids, never post secrets.
- `OwnPosts` is exported, since `PushLoopOptions` and `ToolDeps` now carry one, beside a `handed`
  `SeenSet` of what the agent has been shown.

### Changed

- **Your own messages are never pushed back to you.** They were before, as an indistinguishable
  `<channel>` event.
- **`parley_post` and `parley_reply` answer `{ posted: true, backendMsgId }`** instead of
  `{ backendMsgId }`, or `{ posted: false, … }` when held back.
- **A package scope is not a mention.** `@sharptrick/parley-core` no longer parses as a mention of
  `sharptrick`.
- **The server instructions say what live push carries**, including under `mention_filter`, and the
  handle and `directory` are graded against the untrusted-inbound boundary in the exact text each
  server ships, at load.

### Upgrading from 0.10.0

1. **Handle `posted: false`** wherever an agent or script calls `parley_post`/`parley_reply`, or pass
   `force: true` where a post must not wait.
2. **On Zulip, a message written with `@**handle**` no longer reaches every follower** of its topic —
   only the handles it addresses or mentions. Use a plain `@handle` to name someone without
   withholding the message from the rest.
3. **An embedder building `ToolDeps` or `PushLoopOptions` by hand** must supply `own`, `guardLimit`,
   `whoami` and (for `PushLoopOptions`) `handed` — or build them with `toolDepsFor`.
4. **A handle or `directory` that would break the untrusted-inbound boundary** in the shipped
   instructions is now a load error.

## 0.10.0 — simplification

A simplification pass: presence is gone, `block_ms` is refused by name on the eight backends that
could not serve it, and `subscribe` states the lossiness it always had. Read **Upgrading from
0.9.0** at the end of this section before rolling it over a fleet that is already running.

### Removed

- **Presence, and the `parley_list_users` tool.** There is no roster, no heartbeat topic and no
  reachability answer above the seam. `@sharptrick/parley-core` no longer exports
  `DEFAULT_PRESENCE_TOPIC`, `PresenceKind`, `PresenceRecord`, `RosterEntry`, `RosterOptions`,
  `PresenceLoop`, `PresenceLoopOptions` or `startPresenceLoop`. A config carrying a `presence:`
  block is now a load error that names the key, rather than an "unrecognized field" report.
- **`catchup.block_max_ms: 0` is a load error.** 0.9.0 accepted it. Every caller's `block_ms` is
  clamped to this ceiling before it reaches a plugin, so `0` meant no backend was ever handed a
  budget, none could refuse one, and every long poll answered at once with an empty page the
  caller could not tell from one that timed out. To turn the long poll off, stop sending
  `block_ms`; there is no ceiling that means "disabled".
- Constants that never appeared in a release but are gone from the barrels, for anyone tracking
  `main`: sqlite `CATCHUP_LEDGER_MAX`; zulip `GAP_FILL_PAGE` and `TAIL_PROBE_PAGE`; net-util
  `MAX_BACKOFF_MS` and `clampBackoff`.

### Changed

- **`block_ms` is refused by name on eight of the ten backends** — Discord, Matrix, Postgres,
  Slack, SQLite, Telegram, XMPP and Zulip. Only Redis and NATS have a read primitive to park a
  caller's budget on. Everywhere else `parley_fetch_recent` with a `block_ms` above zero now fails
  with `BlockingFetchUnsupportedError` ("`block_ms` is not supported by this backend … omit
  `block_ms` and poll on your own cadence") instead of returning a page as though the wait had
  happened. This is the change most likely to be felt by a running agent: a page returned as if the
  wait had happened is indistinguishable from a long poll that timed out empty, so an agent that
  believed it was parked was burning a turn per tick. 0.9.0 described `block_ms` as "native on all
  nine event-driven backends"; it was not, and the fallback that stood in for it is gone.
- **`subscribe` is contractually lossy.** A backend guarantees that live push delivers a SUBSET of
  the post-subscribe tail, in cursor order, never a duplicate and never anything from before the
  subscribe — not the whole of it. `fetchRecent`, resuming from the caller's cursor, is what
  reconciles the rest, and the gap-fill machinery that used to paper over the difference has been
  deleted. Any workflow that treated a live handler as the only reader must catch up on a cursor.
- **On-start catch-up writes a second state file.** Alongside `<state_path>/read-state.json` there
  is now `read-state.json.warmed`, recording how far the driver has already paged per topic, so a
  restart warms the dedup set from the live boundary instead of re-reading the whole unread
  backlog. It holds no message and no read position; deleting it costs round trips and nothing
  else, and a marker this process cannot write is logged rather than fatal.
- **`from: 'recent'` no longer consumes the backlog.** On a topic this instance had never read,
  `parley_fetch_recent` with `from: 'recent'` dragged the stored read position to the head of the
  backlog — so everything older became unreachable by resume, on a call that documents itself as
  leaving that position untouched. It now leaves it untouched, including on an empty topic.

### Added

- `@sharptrick/parley-net-util` declares `typescript` as an **optional** peer dependency. Its
  `/testing` subpath now reads the import graph through the TypeScript AST instead of five
  hand-rolled regex readers, so a consumer of that subpath supplies its own `typescript` (the
  runtime entry point is untouched and still dependency-free). The subpath gains
  `checkedExports`, `consumedNames`, `declaredExports`, `starReexports`, `unusedImports`,
  `ImportBinding` and `WorkspacePackage`. `ImportBinding` gained two REQUIRED fields — `kind`
  (`'import'` or `'reexport'`) and `sourceNames` — so code that builds one by hand no longer
  compiles; code that only reads them is unaffected.
- `@sharptrick/parley-core/testing` is a published subpath: `startFakeOidc`, `FakeOidc`,
  `FakeOidcClaims` and the shared failure shapes ship there for downstream test suites.
- Every backend ships a `parley-<name>` bin; previously only `parley-sqlite` existed and the other
  nine were libraries. The inert `backend:` config key — parsed, then read by nothing — is removed
  and rejected at load, naming the binary to run instead. `permissions.skip_permissions`, also
  unimplemented, is a load error rather than a silent no-op.
- CI verifies what it claims: Postgres, Matrix, XMPP and Keycloak run for real (via
  `examples/dev-compose/dev-infra.sh`), and both workflows fail if any test file skips itself.
- First tests for `@sharptrick/parley-net-util`, the shared 429/retry loop behind five backends.
- Cross-backend cursor replay fails with an actionable message instead of a driver stack trace.

### Upgrading from 0.9.0

1. **Delete any `presence:` block from your config** — it is a load error, and the bridge will not
   start with one.
2. **Delete any `backend:` key from your config** — it is a load error too. The backend is chosen
   by which `parley-<name>` bin (or plugin import) you run, not by config.
3. **A mixed fleet is a spoofing surface until every instance is upgraded.** The topic `presence:`
   used to name is no longer reserved, so any instance whose `topics`/`post_topics` reach it can
   now write there — and a peer still running 0.9.0 will read those writes as roster entries,
   trusting the handle each record states about itself. Upgrade every instance on the backend, or
   keep that topic off their allowlists.
4. **Stop sending `block_ms` to anything but Redis and NATS**, or handle the refusal:
   `isBlockingFetchUnsupportedError(err)` recognises it across duplicate installs of core.
5. **The first boot after the upgrade emits less.** Catch-up is bounded by what the driver has
   already paged rather than by the whole unread backlog, and a topic that was never read is no
   longer advanced by `from: 'recent'`.
6. **Some configs that loaded under 0.9.0 are now load errors**, each naming its key:
   - Discord: a `gateway_dialers` above 1000. The bridge now enforces Discord's daily IDENTIFY
     quota itself, and above 1000 dialers each one's share is zero.
   - XMPP: a `nick` or `muc_service` that the server's stringprep would rewrite. That covers
     uppercase or non-NFKC text, zero-width characters, and non-ASCII spaces (in a nick).
     Previously the room answered under the rewritten name and every call timed out.
7. **Postgres no longer runs DDL on every start.** Once the table and trigger exist, a role with
   DML rights alone can run the bridge. A first start without the privilege it needs fails with
   an error that names that privilege.
8. **A Telegram store lock left by a crashed run under the same pid is reclaimed.** A container
   restarted as PID 1 used to refuse its own leftover lock forever. It now takes the lock over
   once the dead run's 30 s lease has lapsed.

## 0.9.0 — `block_ms`

- **Long-poll on `parley_fetch_recent`.** An optional `block_ms` makes the call wait for the next
  message instead of returning an empty page, so a session waiting on a hand-off pays per message
  rather than per interval. Native on all nine event-driven backends, with a generic re-query
  fallback in core for polling-only SQLite — and **zero seam changes**, a capability added after
  the freeze. *(Superseded: see Unreleased — eight of the ten backends now refuse `block_ms` by
  name, and the fallback is gone.)*

## 0.7.0 / 0.8.0 — presence, and an audit pass

- **Reachability roster** *(removed — see Unreleased)*. `parley_list_users` reported who is live *and* recently-seen-but-offline,
  derived above the seam from hello/heartbeat/goodbye beats on one shared reserved topic — so it
  behaves identically on every backend with no new seam method. Beats advertise `post_topics`
  reach; records are versioned.
- 71 audit findings remediated across core and all backends.

## 0.5.0 / 0.6.0 — transport migration

- Core moved onto the MCP SDK's high-level `McpServer` API; topic post patterns and dynamic tool
  descriptions landed alongside.

## 0.2.0 — first automated release

- First release cut by the automated pipeline (semantic-release + npm trusted publishing, with
  build provenance).
- **`@sharptrick/parley-core`: ships the remote/chat OAuth mode** — the OIDC + remote-auth module
  (`src/auth/*`, `src/testing/fake-oidc`). That code landed after core's initial `0.1.0` npm
  publish and had never reached the registry; this release publishes it. The seam interface is
  unchanged.

## 0.1.0 — initial publish

- First npm publish of `@sharptrick/parley-core` and the backends (SQLite, Redis, Matrix, NATS,
  XMPP; Discord, Postgres, Slack, Telegram, Zulip followed) plus the shared conformance suite.
- Note: core's `0.1.0` on npm predates the OAuth/remote mode above — see 0.2.0.
