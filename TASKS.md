# TASKS.md — Parley build checklist

Work top to bottom. Check items off as you **complete and verify** them. Do not skip ahead;
each milestone gates the next. See `DESIGN.md` for the why, `CLAUDE.md` for the how.

Legend: `[ ]` todo · `[x]` done & verified · ⚠ = do not proceed past without satisfying.

---

## v0.1 — `bridge-sqlite`, local stdio, catch-up + polling push (SEAM-PROVING GATE)

### Scaffolding
- [x] S-1. Init monorepo (TypeScript, package-per-plugin under `packages/`). MIT LICENSE.
- [x] S-2. Create `packages/bridge-core` with **zero backend deps**. Lint/test/build wired.
- [x] S-3. Define the seam interface: `connect / disconnect / subscribe / post / fetchRecent /
      resolveIdentity` (signatures per `DESIGN.md` §4).
- [x] S-4. Define the normalized `Message` type (`DESIGN.md` §5) and the opaque `Cursor`,
      `Topic`, `Handle`, `BackendMsgId` types.

### Core engine (backend-agnostic)
- [x] C-1. Dedup + ordering engine: dedup on `backendMsgId`, order on per-topic `cursor`.
      Never use `timestamp`.
- [x] C-2. Catch-up driver: loop `fetchRecent` per configured topic; persist `nextCursor`
      per topic per instance (read-state is **per-instance**, never shared).
- [x] C-3. Reactive MCP tools: expose `post` and `fetchRecent` as standard MCP tools (this is
      the subset chat will also use).
- [x] C-4. Config loader (`DESIGN.md` §11 shape); `backend_config` passed opaquely to plugin.
- [x] C-5. Topic allowlist enforcement; treat inbound as untrusted (no privileged execution).

### SQLite plugin
- [x] Q-1. `packages/bridge-sqlite` implements the seam. Schema with
      `INTEGER PRIMARY KEY AUTOINCREMENT` as the monotonic per-topic cursor.
- [x] Q-2. WAL mode + busy-timeout/retry so concurrent multi-instance `post`s don't error.
- [x] Q-3. `subscribe` = **polling loop only** (`SELECT WHERE cursor > :lastSeen` per topic).
      No socket, no broker. Poll interval is a config knob, no correctness impact.
- [x] Q-4. `resolveIdentity` = string-convention (no real account for local).

### Push half — ⚠ CHANNEL GATE FIRST
- [x] P-1. ⚠ **Verify the channel contract from live docs** (`/en/channels`,
      `/en/channels-reference`) before any push code. Confirm `claude/channel` declaration,
      `<channel>` event schema, reply tool registration, `--channels` dev loading, auth =
      claude.ai subscription. Docs win over `DESIGN.md` on conflict; note discrepancies.
- [x] P-2. Core: backend-agnostic emit handler turning `Message → <channel>` event.
- [x] P-3. Wire SQLite `subscribe` (polling) → emit handler. Live-push filtering:
      forward all messages in subscribed topics; `mention_filter` is a flag in core.
- [x] P-4. Reply path: replies go through the live channel **and** are written to the backend
      via `post` (so they survive restart for the next catch-up).
- [x] P-5. Test the full push flow against the **fakechat** loopback.

### Conventions + conformance
- [x] V-1. Write the **shared conformance suite** against the seam interface (post→fetchRecent
      cursor monotonicity; catch-up-since returns only newer; dedup on double-delivery;
      multi-process write safety). Run it green against `bridge-sqlite`.
- [x] V-2. `CLAUDE.md` catch-up-on-start convention documented; `skills/chat-handoff/` skill
      drafted (post/fetchRecent conventions for the chat instance).
- [x] V-3. README first-line description + function tags (`DESIGN.md` §18).

**⚠ Gate:** v0.1 done only when the conformance suite is green AND the fakechat push loop
works end to end. Do not start v0.2 before this.

---

## v0.2 — Remote / chat mode (OAuth front door)

- [x] R-1. Add the **remote HTTP transport** in `bridge-core/transport/` alongside local stdio.
      Same seam, same SQLite backend underneath.
- [x] R-2. OAuth front door in `bridge-core/auth/`: OAuth 2.1 + PKCE, single-tenant (one
      owner), user-consent. Use a library — implementation unpinned, must be turn-key.
- [x] R-3. Protected Resource Metadata + the 401 → WWW-Authenticate → discovery flow so Claude
      can find the authorization server (verify current connector requirements from docs).
- [x] R-4. Local owner-credential handoff (CLI command / stdin / localhost page) — no secret
      over the public internet at setup. Backend creds stay server-side; Claude only gets a
      consented token.
- [x] R-5. `examples/self-host-remote/` reference deployment; README documents the
      public-exposure requirement + **Anthropic IP-range allowlisting**.
- [x] R-6. Verify a Claude chat connector can connect, `post`, and `fetchRecent` against a
      self-hosted remote-mode Parley (SQLite underneath).

---

## v0.3 — `bridge-redis` (first event-driven push backend)

- [x] D-1. `packages/bridge-redis` implements the seam. Redis Streams: `XADD` ids as the
      monotonic cursor; `XRANGE` for `fetchRecent`.
- [x] D-2. `subscribe` via **`XREAD BLOCK`** — first real event-driven (non-polling) push.
      This milestone proves the event-driven push path.
- [x] D-3. Run the shared conformance suite against `bridge-redis` — green.
- [x] D-4. ⚠ Confirm adding Redis required **zero** changes to `bridge-core`. If not, the seam
      is wrong — fix the seam, not core.
- [x] D-5. README points at the official `redis` Docker image (referenced, not authored).

---

## v0.4 — `bridge-matrix` (first external-network backend)

- [x] M-1. **Read `elkimek/matrix-bridge` first** (prior art; `DESIGN.md` §17) for Matrix
      internals: E2EE via vodozemac, TOFU device trust, mention handling.
- [x] M-2. `packages/bridge-matrix`: room→topic, `event_id`→cursor, sync loop→`subscribe`, room
      history→`fetchRecent`. Shipped as a hand-rolled raw Client-Server HTTP client rather than
      via matrix-js-sdk (the SDK's weight is earned by E2EE device management, which unencrypted
      rooms do not need); the `/sync` token drives the live loop only, it is not the cursor.
- [x] M-3. Conformance suite green against Matrix; zero core changes (⚠).
- [x] M-4. README points to canonical upstream Synapse Docker setup; maintainer throwaway
      instance added to `examples/dev-compose/`.
- [x] M-5. Verify cross-machine operation (Matrix server on a different host than the bridge)
      — proves the decoupling benefit (`DESIGN.md` §10).

---

## v0.5 — `bridge-xmpp`, `bridge-nats`

- [x] X-1. `packages/bridge-xmpp`: MUC→topic, MAM→`fetchRecent`/cursor, PubSub→`subscribe`.
- [x] X-2. README must note **MAM must be enabled** or catch-up has no archive to read.
- [x] N-1. `packages/bridge-nats`: subject→topic, JetStream seq→cursor, wildcard→`subscribe`.
- [x] N-2. Note NATS as the fabric backend (plugs into a larger network mesh).
- [x] Z-1. Conformance suite green against both; zero core changes (⚠).
- [x] Z-2. READMEs point to canonical upstream Docker images (NATS, Prosody/ejabberd).

---

## v1 — definition of done

- [x] Core + sqlite + remote/chat mode + redis + matrix + xmpp + nats all working.
- [x] Shared conformance suite green against **every** backend.
- [x] Adding the final backend required **zero** `bridge-core` changes.
- [x] README has §18 description + tags; each network plugin README points to upstream Docker
      (XMPP notes MAM).
- [x] chat-handoff skill + catch-up-on-start convention documented.
- [x] Re-scan prior art by **function** (not name) for new entrants; update `DESIGN.md` §17.

---

## Post-v1: external OIDC (Keycloak) auth mode for remote/chat

- [x] K-1. Config: optional `auth` block (`mode: builtin | oidc` + `auth.oidc` schema); absent =
      builtin, fully backward compatible.
- [x] K-2. `bridge-core/auth`: `OidcTokenVerifier` (JWKS sig, iss, exp/nbf ± skew, aud always;
      scope + identity gates on top), `fetchOidcDiscovery`, and the delegated-RS composition
      `createOidcRemoteApp` (PRM → external issuer; no local /authorize, /token, /register).
- [x] K-3. `createRemoteAuthApp` selector; `examples/self-host-remote` boots either mode from
      config (no owner secret needed in oidc mode).
- [x] K-4. Tests: fake in-process IdP (always-run unit + e2e through the real MCP SDK client)
      plus a dev-compose Keycloak realm import with a gated live suite (self-skips when down).
- [x] K-5. Docs: `docs/keycloak-integration.md` (realm setup: audience mapper, DCR trusted
      hosts, owner role; config reference; security notes) + README/DESIGN updates.
- [x] K-6. Zero changes to `createOAuthRemoteApp` / `ParleyOAuthProvider` / `transport/http.ts` (⚠).

## Post-v1: five more backends (v0.6)

- [x] `packages/bridge-postgres` — table + `LISTEN`/`NOTIFY`; `BIGSERIAL` cursor ordered by a
      per-topic advisory lock so seq order == commit order. Verified against live Postgres 16.
- [x] `packages/bridge-zulip` — stream+topic→topic, message id→cursor, event-queue long-poll.
      In-process fake by default, plus an env-gated real-server suite.
- [x] `packages/bridge-discord` / `bridge-slack` / `bridge-telegram` — hosted SaaS; gateway,
      Socket Mode, and `getUpdates` respectively. Verified against in-process API fakes.
- [x] Telegram's fit-contract gaps documented rather than faked: the Bot API has no history
      endpoint, so `fetchRecent` replays a local store of *observed* messages — no pre-join
      backfill, ever — and one poller per token makes multi-writer structurally impossible, so
      that conformance case is skipped by design.
- [x] Zero `bridge-core` changes across all five (⚠).

## Post-v1: presence + reachability roster

- [x] Presence beats (hello/heartbeat/goodbye) on ONE shared, reserved topic; `parley_list_users`
      derived above the seam so it works on every backend with no new seam method.
- [x] Offline-aware roster (recently-seen peers, not just live ones); instance-scoped liveness;
      beats advertise `post_topics` reach; presence records versioned (additive fields).

## Post-v1: `block_ms` long-poll (issue #20)

- [x] Optional `blockMs` hint on the seam's `fetchRecent`, exposed as `block_ms` on
      `parley_fetch_recent`; server-side cap `catchup.block_max_ms`.
- [x] Native implementations on all nine event-driven backends; generic re-query fallback in core
      for polling-only SQLite.
- [x] Zero `bridge-core` seam changes — a capability added *after* the freeze (⚠).

## Post-v1: release automation + consolidation

- [x] `semantic-release` on merge to `main`; lockstep publish of every package with provenance via
      OIDC trusted publishing; PR-title lint drives the bump; pre-merge publish preflight.
- [x] A bin for every backend (`parley-<name>`), so all ten are runnable; the inert `backend:`
      config key removed and rejected at load, and `skip_permissions` made a load error.
- [x] CI runs every backend for real (redis, nats, postgres, xmpp, matrix, keycloak via
      `dev-infra.sh up all`) and fails if any test file skips itself.
- [x] `docs/1.0-readiness.md` — the evidence for cutting 1.0, and the mechanics.

## Deferred (post-v1, deferred on purpose — not oversights)

- [ ] Spawn-on-unknown-handle (launch a Code instance for a not-yet-running handle).
- [ ] Richer payloads (files / images).
- [ ] Multi-instance routing beyond per-session bridges.
- [ ] Splitting plugins into separate repos. **Its gate is now met** — the stated condition was
      "two consecutive backends land with zero core changes", and every backend after sqlite has,
      nine in a row. Still deferred: lockstep versioning across one repo is working, and splitting
      would trade that for cross-repo release choreography with no current benefit. Revisit if the
      packages ever need independent release cadences.
