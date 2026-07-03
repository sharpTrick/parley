# Changelog

Parley's packages are versioned in lockstep — every `@sharptrick/parley-*` package shares one
version. Releases are automated (see [`CONTRIBUTING.md`](CONTRIBUTING.md) → "Releases &
versioning"), and the canonical, always-current per-release notes are the
**[GitHub Releases]** (generated automatically from commit messages). This file is a hand-kept
highlight reel of the milestones.

[GitHub Releases]: https://github.com/sharpTrick/parley/releases

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
