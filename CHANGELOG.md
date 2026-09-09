# Changelog

Parley's packages are versioned in lockstep — every `@sharptrick/parley-*` package shares one
version. Releases are automated (see [`CONTRIBUTING.md`](CONTRIBUTING.md) → "Releases &
versioning"), and the canonical, always-current per-release notes are the
**[GitHub Releases]** (generated automatically from commit messages). This file is a hand-kept
highlight reel of the milestones.

[GitHub Releases]: https://github.com/sharpTrick/parley/releases

## Unreleased

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
2. **A mixed fleet is a spoofing surface until every instance is upgraded.** The topic `presence:`
   used to name is no longer reserved, so any instance whose `topics`/`post_topics` reach it can
   now write there — and a peer still running 0.9.0 will read those writes as roster entries,
   trusting the handle each record states about itself. Upgrade every instance on the backend, or
   keep that topic off their allowlists.
3. **Stop sending `block_ms` to anything but Redis and NATS**, or handle the refusal:
   `isBlockingFetchUnsupportedError(err)` recognises it across duplicate installs of core.
4. **The first boot after the upgrade emits less.** Catch-up is bounded by what the driver has
   already paged rather than by the whole unread backlog, and a topic that was never read is no
   longer advanced by `from: 'recent'`.

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
