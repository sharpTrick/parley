# Contributing to Parley

Thanks for considering a contribution. Parley has a small number of architectural rules that are
easy to violate by accident if you don't know they're there — this doc exists so you find out
*before* writing code, not after a PR review. **Read [`DESIGN.md`](DESIGN.md) before making any
non-trivial change** — it's the source of truth this project is built against.

## The one rule that matters most

> **The seam is the product.** Everything backend-specific lives behind one small interface
> (`connect / disconnect / subscribe / post / fetchRecent / resolveIdentity`, defined in
> [`packages/bridge-core/src/seam.ts`](packages/bridge-core/src/seam.ts)). `@sharptrick/parley-core` must
> **never** import from a backend plugin. Dependencies point one way: plugins depend on core,
> never the reverse.

The practical test: **adding or changing a backend should touch only that backend's own package,
never `@sharptrick/parley-core`.** If you find yourself wanting to special-case a backend inside core, or to
change the seam's method signatures to accommodate one backend's quirk, stop — that's a sign the
seam (or your approach) needs rethinking, not a quick patch. Open an issue describing the gap
before sending a PR; a seam change is the one kind of change that needs discussion first.

Concretely, the seam (`seam.ts`, `message.ts`) and the shared conformance suite
(`@sharptrick/parley-conformance`) are **frozen** as of v0.1 — every backend since then (Redis, Matrix, NATS,
XMPP) was added without touching either.

## Other invariants worth knowing before you start

- **Never order or dedupe on `timestamp`.** Use `backendMsgId` (the dedup key) and the monotonic
  per-topic `cursor` (the order key). Timestamps are informational only — clock skew and ties make
  them unsafe for ordering. See `DESIGN.md` §5/§6.
- **A conforming backend guarantees:** a stable, unique `backendMsgId` per message, and monotonic,
  in-order, exclusive-`since` cursor delivery. `fetchRecent` returns messages pre-sorted ascending;
  `subscribe`'s handler fires in ascending order per topic. Core never parses or compares cursor
  values — it trusts the plugin.
- **Inbound is untrusted.** A message arriving from a backend becomes agent context, never a
  privileged instruction. Don't add code paths that treat topic content as commands.
- **The topic allowlist is not optional.** `config.topics` *is* the allowlist — no wildcard
  "subscribe to everything" mode. Any new tool or entry point must go through it.
- **`skip_permissions` defaults OFF, sandbox-only.** Never flip a security default on to make a
  test or a demo more convenient.
- **Secrets** (tokens, JIDs, passwords, owner passphrases) live in `backend_config` / `.env`,
  never hardcoded, never committed.

## Adding a new backend

1. Read `DESIGN.md` in full, then skim an existing plugin (`packages/bridge-redis/src/index.ts` is
   a clean, relatively small reference) to see the shape.
2. Scaffold `packages/bridge-<name>/` following the existing packages' `package.json`/`tsconfig`
   conventions, depending on `@sharptrick/parley-core` and (as a dev dependency) `@sharptrick/parley-conformance`.
3. Implement `BackendPlugin` (`connect`, `disconnect`, `subscribe`, `post`, `fetchRecent`,
   `resolveIdentity`). Map the backend's native ordering primitive to `cursor` and its native unique
   message id to `backendMsgId` — see any existing plugin's README "Mapping" table for the pattern.
4. Add `packages/bridge-<name>/test/conformance.test.ts` calling
   `runConformanceSuite('<name>', factory)` from `@sharptrick/parley-conformance` — see
   [`packages/conformance/README.md`](packages/conformance/README.md) for the `BackendFactory`
   shape. Have the factory skip cleanly (not fail) when no server is reachable, matching the
   existing network backends' pattern. For hosted-SaaS backends with no self-hostable server
   (Discord/Telegram/Slack pattern), run the suite against a minimal **in-process fake** of the
   API subset the plugin uses (see `packages/bridge-slack/test/fake-slack.ts`), optionally with
   an env-gated real-credential suite on top.
5. Run `npm test`. Then confirm the success criterion: `git diff --stat packages/bridge-core`
   must be **empty**. If it isn't, the seam is missing something — raise it as an issue rather than
   patching around it.
6. Write the package README following the existing backends' format: a seam-mapping table, a
   `backend_config` table, a "Run it" section pointing at the *canonical upstream* Docker image
   (don't author new production infra — a throwaway dev harness belongs in
   `examples/dev-compose/` instead), and a "Multiple concurrent sessions" section if the backend
   has any shared-state gotchas (see [`examples/multi-session`](examples/multi-session/README.md)
   for the pattern other backends follow).

## Dev setup

```bash
npm install
npm run build
npm test          # full suite; network-backend conformance suites skip cleanly with no server up
```

Node **>=22** (see each `package.json`'s `engines` field). For the network backends, bring up a
throwaway server via [`examples/dev-compose`](examples/dev-compose/README.md) to get their
conformance suites to actually run instead of skip.

## Before opening a PR

- `npm run build && npm test` green locally.
- Small, focused commits over one large one — each logical change is easier to review on its own.
- If you touched a backend's `backend_config` shape, update that backend's README (the config
  table + any shared/per-session notes) in the same PR.
- If you're not sure whether a change is a "seam change," ask first (open an issue) rather than
  find out via review — see "The one rule that matters most" above.
