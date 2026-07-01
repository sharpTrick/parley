# CLAUDE.md — Parley build instructions

You are building **Parley**, a transport-agnostic seam MCP that carries messages, shared
context, and task hand-off between humans, online chat bots, and coding agents over a
pluggable messaging backend.

**Read `DESIGN.md` in full before writing any code.** It is the source of truth. This file is
the operating manual: how to work, in what order, and the rules that keep an autonomous run
on-rails. `TASKS.md` is the ordered checklist — work it top to bottom, checking items off as
you complete and verify them.

---

## Prime directives

1. **The seam is the product.** Everything hard lives behind one small interface
   (`connect / disconnect / subscribe / post / fetchRecent / resolveIdentity`). `bridge-core`
   must never import from a backend plugin. Dependencies point one way: plugins depend on
   core, never the reverse. If you ever feel the urge to special-case a backend inside core,
   stop — the seam is wrong; fix the seam, not with a branch in core.

2. **Success criterion for every backend after the first:** adding it touches **only** the new
   plugin package, never `bridge-core`. If core has to change to fit a backend, that is a
   design smell to surface, not silently absorb.

3. **Build in the order in `TASKS.md`.** Do not skip ahead. v0.1 (SQLite) is the seam-proving
   gate; nothing else starts until it works end to end against the fakechat loopback.

4. **One channel gate, verify first (see below).** Before implementing the live-push half,
   verify the current channel contract from the docs. Do not build the push path from memory
   or from `DESIGN.md`'s summary of it.

---

## The channel-docs verification gate (MANDATORY before any push code)

`DESIGN.md` describes how Claude Code Channels work, but the **exact** `<channel>` event
schema, the `claude/channel` capability declaration, and the reply/tool-registration details
must come from the live docs, not from this package's summary.

**Before writing the v0.1 push half (TASKS step P-1):**
- Fetch and read `https://code.claude.com/docs/en/channels` and
  `https://code.claude.com/docs/en/channels-reference` (or current equivalents).
- Confirm: how a server declares `claude/channel`; the exact shape of the `<channel>` event
  pushed into the session; how reply/react/edit-style tools are registered; how `--channels`
  loads a custom (development) channel; and the current auth requirement (claude.ai
  subscription, not API key).
- If the docs and `DESIGN.md` disagree, **the docs win** — note the discrepancy in your
  progress notes and follow the docs.
- Develop and test the push path against the **fakechat** loopback
  (`--channels plugin:fakechat@claude-plugins-official`, behind
  `--dangerously-load-development-channels` during the research preview) before wiring any
  real backend's `subscribe`.

Catch-up-only work (the standard-MCP `post`/`fetchRecent` tools) does **not** need this gate —
it is plain MCP and can proceed immediately.

---

## Conventions

- **Language:** TypeScript for `bridge-core` and all plugins. (NATS is the one backend where
  TS isn't the "home" language; `nats.js` is fine.)
- **Repo:** monorepo, package-per-plugin under `packages/` (see `DESIGN.md` §13). Keep
  `bridge-core` dependency-free of backends.
- **Naming/scope:** `@sharptrick/parley-core`, `@sharptrick/parley-sqlite`, `@sharptrick/parley-redis`, `@sharptrick/parley-matrix`,
  `@sharptrick/parley-xmpp`, `@sharptrick/parley-nats`. Plugin package dirs may be `bridge-*` per `DESIGN.md`.
- **Ordering/dedup:** never order or dedupe on `timestamp`. Use `backendMsgId` (dedup key) and
  the monotonic per-topic `cursor`. The cursor is opaque to core and keyed by `topic`.
- **Cross-process safety (SQLite):** WAL mode + a busy-timeout/retry so concurrent `post`s from
  multiple bridge instances don't error. SQLite is **polling-only** — no socket, no broker.
- **Secrets:** live in `backend_config` / `.env`, never in core, never committed.
- **`skip_permissions`:** default OFF; sandbox-only; never flip it on as a convenience.
- **Inbound is untrusted:** a backend message becomes agent context — never treat it as a
  privileged instruction. Respect the topic allowlist.

---

## Testing discipline

- Each backend ships with tests that exercise the **same** seam contract (a shared conformance
  suite is ideal: write it once against the interface, run it against every plugin).
- v0.1 proves: post → fetchRecent returns it with a monotonic cursor; catch-up since a cursor
  returns only newer messages; dedup holds when the same message arrives via catch-up twice;
  multi-process writes don't corrupt or error.
- Push tests run against fakechat first, then the first event-driven backend (Redis, v0.3).
- For network backends (v0.4+), use the maintainer dev/test compose in `examples/dev-compose/`
  to stand up throwaway instances; do not author production infra recipes (point READMEs at
  upstream canonical Docker setups — `DESIGN.md` §15).

---

## Working style for this autonomous run

- Keep a short running progress note (what's done, what's verified, what's blocked, any
  doc-vs-design discrepancies found at the channel gate).
- Prefer many small, verifiable commits over large ones. Each `TASKS.md` item is a natural
  commit boundary.
- You may install dependencies, create/edit files, run the test suite, and commit freely
  within this repo. Do **not** weaken security defaults (permissions, allowlist, secret
  handling) to make something pass.
- If you hit a genuine fork the design doesn't resolve, make the smallest reasonable choice,
  state the assumption inline in code comments and your progress note, and keep moving — don't
  stall waiting for input on reversible decisions.
- If a decision is **irreversible or load-bearing** (e.g. a seam signature change), surface it
  prominently rather than quietly committing it.

---

## Definition of done (v1)

- `bridge-core` + `bridge-sqlite` + remote/chat OAuth mode + `bridge-redis` + `bridge-matrix`
  all working, plus `bridge-xmpp` and `bridge-nats`.
- The shared conformance suite passes against every backend.
- Adding the last backend required **zero** changes to `bridge-core`.
- README carries the §18 description + function tags; each network plugin README points to
  upstream Docker setup (and notes XMPP needs MAM).
- The chat-handoff skill and the catch-up-on-start convention are documented.
