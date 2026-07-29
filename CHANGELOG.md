# Changelog

Parley's packages are versioned in lockstep — every `@sharptrick/parley-*` package shares one
version. Releases are automated (see [`CONTRIBUTING.md`](CONTRIBUTING.md) → "Releases &
versioning"), and the canonical, always-current per-release notes are the
**[GitHub Releases]** (generated automatically from commit messages). This file is a hand-kept
highlight reel of the milestones.

[GitHub Releases]: https://github.com/sharpTrick/parley/releases

## Unreleased

- **Every backend is runnable.** Each package ships a `parley-<name>` bin; previously only
  `parley-sqlite` existed and the other nine were libraries. The inert `backend:` config key —
  parsed, then read by nothing — is removed and rejected at load, naming the binary to run.
  `permissions.skip_permissions`, also unimplemented, is now a load error rather than a silent
  no-op.
- **CI verifies what it claims.** Postgres, Matrix, XMPP and Keycloak now run for real in CI (via
  `examples/dev-compose/dev-infra.sh`), and both workflows fail if any test file skips itself.
  Seven of 57 files used to skip on every green build. 460 tests, none skipped.
- Cross-backend cursor replay now fails with an actionable message instead of a driver stack trace.
- First tests for `@sharptrick/parley-net-util`, the shared 429/retry loop behind five backends.
- README documents `block_ms` and the full config surface; the four backends npm still described as
  "skeletons" are described accurately.

## 0.9.0 — `block_ms`

- **Long-poll on `parley_fetch_recent`.** An optional `block_ms` makes the call wait for the next
  message instead of returning an empty page, so a session waiting on a hand-off pays per message
  rather than per interval. Native on all nine event-driven backends, with a generic re-query
  fallback in core for polling-only SQLite — and **zero seam changes**, a capability added after
  the freeze.

## 0.7.0 / 0.8.0 — presence, and an audit pass

- **Reachability roster.** `parley_list_users` reports who is live *and* recently-seen-but-offline,
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
