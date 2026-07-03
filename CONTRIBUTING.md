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
7. **First publish (one-time).** A brand-new package has to be published by hand *once* before
   automation can take over — npm trusted publishing can only be configured on a package that
   already exists. See [Releases & versioning](#releases--versioning) for the exact steps. Every
   release after that is automatic.

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
- **Title your PR as a [Conventional Commit].** A merge to `main` publishes, and the PR title is
  the message that decides the version bump — see [Releases & versioning](#releases--versioning).
  A CI check (`lint-title`) enforces this. Use `docs:`/`chore:`/`ci:` for changes that shouldn't
  cut a release.
- Small, focused commits over one large one — each logical change is easier to review on its own.
  (Branch commits are squashed on merge, so they're for reviewers, not the changelog.)
- If you touched a backend's `backend_config` shape, update that backend's README (the config
  table + any shared/per-session notes) in the same PR.
- If you're not sure whether a change is a "seam change," ask first (open an issue) rather than
  find out via review — see "The one rule that matters most" above.

## Releases & versioning

Releases are **fully automated**. A merge to `main` *is* a release — there's no separate publish
step, and you should never `npm publish` by hand or hand-edit a `package.json` version (the one
exception is the first publish of a brand-new package — see below).

How it works:

- On every push to `main`, CI runs the full test gate. If it's green,
  [semantic-release](https://semantic-release.gitbook.io) reads the conventional-commit messages
  since the last `vX.Y.Z` tag, decides the bump, creates the tag + a GitHub Release, stamps that
  one version across **all** workspace packages (lockstep), and publishes every public package to
  npm with provenance — via trusted publishing (OIDC), so there are no npm tokens anywhere.
  Config lives in [`.releaserc.json`](.releaserc.json) and
  [`.github/workflows/release.yml`](.github/workflows/release.yml).
- **No bump is committed back** to the tree. The git tag + npm are the source of truth for the
  current version; `package.json` versions on `main` stay at the last-released number between
  releases. Don't hand-edit them — the release stamps them in CI.

### The PR title is what releases

Merges are **squash-only**, and the PR title becomes the squash commit's subject (a `lint-title`
check enforces that it's a valid [Conventional Commit]). So the **PR title is authoritative** — your
branch's individual WIP commits are squashed away and don't affect the release. Prefix it:

| PR title prefix | Release | Example |
| --- | --- | --- |
| `feat:` | **minor** | `0.1.0 → 0.2.0` |
| `fix:` / `perf:` / `revert:` | **patch** | `0.1.0 → 0.1.1` |
| `feat!:` (any `type!:`, or a `BREAKING CHANGE:` footer in the PR body) | **major** | `0.1.0 → 1.0.0` |
| `docs:` `chore:` `ci:` `build:` `refactor:` `style:` `test:` | **none** | no release |

> **While Parley is pre-1.0, avoid `!` / `BREAKING CHANGE`.** semantic-release has no special 0.x
> handling — a breaking change jumps straight to `1.0.0`, not `0.2.0`. Land breaking-but-early
> changes as `feat:` until you deliberately mean to cut 1.0.

`main` is protected: PRs only, both CI checks green and up to date, linear history, squash-only.
Keep non-release work on feature/dev branches — a merge to `main` ships.

### First publish of a brand-new package (the one manual case)

npm trusted publishing can only be configured on a package that already exists, so a new backend
package must be published once by hand before automation can take over:

```bash
npm login                                                   # a @sharptrick publisher
npm run build
npm publish -w @sharptrick/parley-<name> --access public    # no provenance on this bootstrap publish
```

Then add the trusted publisher on npmjs.com (the package → **Settings → Publishing access → Add
trusted publisher**: repo `sharpTrick/parley`, workflow `release.yml`). From the next release on,
it's automated like every other package.

### Recovering a partial release

If a release publishes only some packages (e.g. a registry hiccup mid-run), re-run the **Publish
(manual)** workflow (Actions tab → *Run workflow* → enter that release's version). It re-stamps and
publishes idempotently, skipping anything already on the registry
([`.github/workflows/publish-manual.yml`](.github/workflows/publish-manual.yml)).

[Conventional Commit]: https://www.conventionalcommits.org
