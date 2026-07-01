# Security Policy

Parley is a young (pre-1.0) project. Security issues are taken seriously even at this stage —
please report them privately rather than opening a public issue.

## Reporting a vulnerability

**Preferred: GitHub Private Vulnerability Reporting.** Use this repository's **Security** tab →
**Report a vulnerability** to open a private advisory. This reaches the maintainer directly and
keeps the report out of public issues/PRs until a fix is ready.

Please do **not** open a public GitHub issue for a suspected vulnerability.

When reporting, include:
- What component is affected (`@parley/core`, a specific backend plugin, the remote/OAuth server,
  a skill, etc.).
- Steps to reproduce, or a minimal repro config.
- What you'd expect to happen vs. what actually happens.

There's no fixed SLA (this is currently a personal, unfunded project), but reports will be
acknowledged and triaged as soon as possible, and credited in the fix's changelog/release notes
unless you ask not to be.

## Scope

**In scope** — vulnerabilities in this repository's own code:

- The core seam, dedup/ordering engine, and topic allowlist (`@parley/core`).
- Any backend plugin's handling of its own credentials or connection (`@parley/sqlite`,
  `@parley/redis`, `@parley/matrix`, `@parley/xmpp`, `@parley/nats`).
- The remote/chat OAuth 2.1 + PKCE front door (token issuance, consent, audience binding, dynamic
  client registration) — see `DESIGN.md` §10/§14 and `examples/self-host-remote`.
- Anything that lets inbound backend content (which is meant to be treated as **untrusted data**,
  never as an instruction) escape that boundary and act with elevated trust — e.g. a path where
  message content could be misinterpreted as a tool call, a permission grant, or otherwise
  influence the bridge's own behavior rather than just being surfaced as context.
- Anything that defeats the topic allowlist (reading/writing/subscribing outside `config.topics`).
- Anything that weakens `skip_permissions`'s default-off posture or makes it easier to enable
  unintentionally.

**Out of scope** — please report these upstream instead:

- Vulnerabilities in the backend servers themselves (Redis, NATS, Synapse/Matrix, Prosody/ejabberd
  XMPP) — report to those projects.
- Vulnerabilities in third-party dependencies with no Parley-specific exploitation path — report
  upstream (or via `npm audit`/a Dependabot alert here, which is fine as a normal issue/PR, not a
  private report).
- Social-engineering or physical-access scenarios that don't involve a defect in this code.

## Supported versions

Pre-1.0: only the latest code on `main` is supported. There are no maintained release branches
yet.
