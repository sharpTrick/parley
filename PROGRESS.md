# PROGRESS.md — Parley build notes

> Running progress note + context-rehydration anchor. Durable state = **git history + a green
> conformance run + this file**. Any context window can be cleared and rebuilt from these three.
> Format: what's done · what's verified · what's blocked · doc-vs-design discrepancies.

## Status

- **Phase (adversarial review — the Careening experiment):** rounds 1–11 complete and pushed on
  `claude/next-steps-q1540r`. Full suite **12173 tests, 4 skipped, green**, against real Redis, NATS,
  Postgres, Prosody, Synapse and Keycloak (all six bound to loopback only).

  Findings per round (14 targets each, 0 errored every round):

  | round | findings | CONFIRMED | blocking | self-induced | blocking self-induced |
  | ---: | ---: | ---: | ---: | ---: | ---: |
  | 1 | 139 | 124 | 61 | — (not gradeable) | — |
  | 2 | 136 | 130 | 49 | 26% | 27% |
  | 3 | 119 | 115 | 38 | 39% | 34% |
  | 4 | 120 | 113 | 45 | 57% | 56% |
  | 5 | 129 | 117 | 39 | 60% | 72% |
  | 6 | 90 | 86 | 26 | 80% | 81% |
  | 7 | 79 | 75 | 23 | 66% | 57% |
  | 8 | 73 | 71 | 25 | 56% | 62% |
  | 9 | 71 | 68 | 28 | 63% | 61% |
  | 10 | 75 | 72 | 29 | 75% | 72% |

  Round 6 was the first round where every count fell at once — findings 129→90, CONFIRMED 117→86,
  blocking 39→26 — while self-induction rose to 80%, and I read that as the loop running out of
  original codebase. **Round 7 refutes that reading.** Self-induction fell 80% → 66%, blocking
  self-induction fell 81% → 57%, and pre-existing findings ROSE 18 → 27 (blocking 5 → 10). The loop
  found twice as many original blocking defects in round 7 as in round 6, including a malformed
  gateway frame that kills the whole MCP server process. The five-round monotone rise
  (27 → 34 → 56 → 72 → 81) simply does not continue.

  The oracle was re-run over rounds 5 and 6 before this was believed, and reproduced their recorded
  60%/72% and 80%/81% exactly — so the reversal is in the data, not the instrument. Whatever round 6
  measured, it was not saturation.

  Suite series: **460 → 1428 → 2545 → 3926 → 5241 → 6806 → 7580 → 8847 → 9706 → 10968 → 11836 → 12173**.

  **Round 11 was a DECOMPOSITION round, not a review round** — a deliberate regime boundary, on
  Patrick's call after observing that source had doubled per backend while the file count had not.
  Eleven targets, all net-negative on source, every suite passing UNMODIFIED. Biggest source file
  **1499 → 1014**; packages carrying a >900-line file **9 of 10 → 2**; 24 files → 78.

  **The finding is that our own ratchet had been cementing the monoliths, in five distinct ways:**
  a split BLOCKED (postgres counts a regex over `src/index.ts`; slack requires every `api()` call
  site in it; nats pins two prose strings into it); a guard SILENTLY HOLLOWED (matrix's negative
  assertions still pass but now grade a file that no longer holds the code they were written
  about); a debt made INVISIBLE (net-util's fork registry keyed by file path and scanned only
  importing files, so a split could retire a recorded security debt with the suite green); a SHAPE
  lock (redis's test asserts a private field is an Array, so the `ReaderPool` the scope asked for
  failed 20 tests on shape, not behaviour); and a lint with a HOLE (zulip's export-surface regex
  misses `export async function`, proven by a real export it failed to flag).

  Ten rounds of ratcheting made the code harder to simplify, and nothing in the protocol noticed.
  Re-anchoring those assertions from one path to a glob over `src/**` is the highest-value change
  still available — and it touches TESTS, which the net-negative-on-source rule deliberately frees.

  Honest caveat: margins were thin (xmpp −3, shared −5). A multi-file split costs 30–50 lines of
  irreducible import ceremony, and the reductions came mostly from duplication the split REVEALED —
  four copies of one `ws.close()`, two throttled reporters, one hazard comment stated three times —
  not from the move itself.

  **Halfway reading (round 10).** Neither series has converged and neither is monotone.
  Pre-existing BLOCKING findings ran 36 → 25 → 20 → 11 → 5 through round 6, then RECOVERED to
  10, 9, 11, 8 and have sat in that band for four rounds. This is a STEADY STATE, not the
  two-regime decay ouroboros described: ten rounds in, on a codebase nine prior full-surface
  sweeps have covered, the loop still finds 8–11 original blocking defects per round while about
  two thirds of its blocking output is against its own prior work. Where saturation appears it is
  package-local and shows up as MUTATION COST rather than finding count — core-auth needed 27
  mutations in round 8 to establish it had no vacuous tests and 52 in round 9 to surface two.

  **Round 10's theme: critics find well and prescribe badly, and the separation is what catches
  it.** Five remediations in round 9 and five more here would have introduced or blessed a defect
  if implemented as written. zulip was told to use `topic.trim()` — the wrong Unicode set in both
  directions (JS `trim` excludes U+0085 and includes U+FEFF; pydantic's is the reverse). nats was
  told to delete a clamp whose comment was wrong but whose code was load-bearing for a different
  reason. slack's finding 2 would have returned a parked caller at the deadline in exactly the
  case an existing test pins as returning on the loss. xmpp's test upgrade asked for a row a real
  Prosody refutes — it strips the stanza the row would have injected. And a proposed comment lint
  did not fire on the five instances it was written for.

  **Three agents used mutation testing to SUBTRACT**, in three consecutive rounds: matrix built
  the `noAuth` flag its finding specified, watched the mutation survive, and deleted it; slack
  implemented a read floor, measured it working, could not state an invariant it satisfied that
  the ladder did not, and reverted it; postgres implemented a listener clear, mutated it away
  alone, saw every cell pass, and left it out.
  Note the series stops being a clean proxy at round 9: telegram's count FELL 527 → 523 while its
  coverage rose (per-field cells collapsed from one-case-per-breakage to one-case-per-field looping
  its breakages — 4 fields to 9, 15 breakage cells to 37, each gaining a cold-restart post-condition).

  **Round 9's dominant theme: the proposed remediation was itself defective, five times.** xmpp's
  empty-page fix would have violated a frozen conformance clause the suite cannot currently exercise;
  xmpp's `<delay>` guard was told to compare the room's BARE JID, which an occupant's full JID
  satisfies, admitting exactly the forgery it was written to stop; redis's socket-leak finding
  measured its own probe server (a paused readable never sees EOF — `s.resume()` and the leak is
  zero); telegram's proposed lint would have PASSED on the saturating assertion that motivated it;
  and slack's session-scope fix, written as specified, captures the NEW session because the first
  fetch is what straddles the boundary. Critics are now reliable at finding defects and unreliable at
  prescribing fixes — which is an argument for keeping remediation a separate reasoning pass rather
  than folding it into review.

  **Two agents subtracted rather than added.** nats reverted a defence-in-depth guard it had already
  written when the mutation survived; core-engine withheld four barrel exports the finding asked it
  to add, because an earlier round had deliberately trimmed them. Mutation discipline used to shrink
  the diff, not just to justify it.

  **Round 8 changed the frozen seam for the first time**, on Patrick's adjudication. `seam.ts` said
  `blockMs` engages "only relative to a `since`"; core's long-poll wrapper, the `parley_fetch_recent`
  tool description and the conformance suite all said the opposite, and eight of ten backends already
  behaved the other way. The frozen file was the minority report. It matters because a since-less read
  is the FIRST call of every session — the one an agent makes before it holds a cursor.

  **Round 8's saturation signal is package-local, not global.** core-auth's critic ran 27 mutations
  over its whole surface — unbinding `redirect_uri` at `/token`, dropping the RFC 8707 audience check,
  deleting the empty-passphrase guard, 24 more — and the existing suite caught **all 27**, so it filed
  no test-integrity and no test-hygiene finding at all. That is what a package with no vacuous tests
  looks like under this protocol, on the deepest security surface in the repo, after eight rounds.

  **Two more process defects, both produced BY this protocol's own advice.** The stash stack lives in
  the common git dir, so two agents restored each other's work into the wrong worktrees; and
  `git checkout -- <file>`, which the protocol recommended for undoing a mutation, restores from the
  round base and wiped three agents' in-progress fixes. Both are round 7's `index.ts.bak` collision
  one level down: isolation that holds for the working tree and silently does not below it.

  **A measurement trap worth remembering.** A matrix conformance timing failure looked like it was
  caused by the seam change; it reproduced identically at HEAD without the change, and vanished on a
  recreated Synapse. The shared homeserver degrades from accumulated EVENTS, not just joined rooms —
  the joined-room count used as a proxy in round 7 read a healthy 10 throughout. Recreate the server and
  re-measure before attributing a live-server timing change to a diff.

  **Round 7's themes.** Fixture fidelity persisted from round 6 and stayed the most productive lens:
  nats' fake modelled foreignness with a boolean instead of the subject, so deleting `filter_subject`
  from all three `consumers.add` calls left the fake-backed suite green at 190/190 while a live
  wildcard stream leaked a sibling topic into the handler; zulip's fake echoed `content` verbatim
  while the real server strips edges, refuses empty bodies and truncates at 10 000 chars — modelling
  it turned a FROZEN conformance clause red, because the plugin took neither arm.

  New in round 7: **a suite that had already noticed a defect and frozen it as correct.** Slack's
  `envelope-robustness` asserted `liveSockets === 2` under the label `orphaned sockets`. That is why
  the socket leak survived six rounds — not that no one looked, but that the test named the bug and
  blessed it.

  **Three agents' guards failed their own first mutation** and each fixed the test rather than
  reporting success: discord's fault boundary (the only unwrapped statement was the waiter fan-out),
  shared's credential table (the `path segment` location echoed the whole path, so the pathname rule
  claimed it whatever the token looked like — it graded the shape of nothing), and telegram's docs
  cell (one served chat never exceeded the cap, so load-time eviction never bit). Mutation testing
  is the only reason those three ratchets are real.

  **Cross-target collisions are now a recurring cost.** Round 6 had none; round 7 had three. Core's
  new `set()` validation contradicted a matrix table titled "every cursor form a read-state file can
  hold" — matrix's row was the wrong one, since `load()` has always refused an empty cursor. Core's
  new `MAX_BLOCK_MS` ceiling made slack's README cite an unreachable configuration. And the shared
  target's tightened since-less bound reddened matrix, which answers that read in 4.1-4.8 s against
  a live Synapse — a real provisioning cost, not a park.

  **A process defect the worktrees do not cover.** Worktrees isolate each agent's repository; the
  scratchpad is shared. Two agents independently wrote `index.ts.bak` there, and matrix's restore
  pulled bridge-slack's source into `bridge-matrix/src/index.ts`. Both recovered from git. Recorded
  in `docs/REVIEW_PROTOCOL.md` with the fix: per-target scratch paths, or better, `git checkout --`
  instead of a backup at all.

  **Stop rule: two consecutive wake-all rounds with zero CONFIRMED findings, or round 20.** Offered
  the blocking-gated alternative at round 3 and deliberately declined it, to keep comparability with
  ouroboros's acting rule; the shadow metric is still recorded. Quiescence has never fired — all 14
  targets have returned confirmed findings in all seven rounds — and that null result is the finding.

  **Before launching a round: `node scripts/careening-preflight.mjs`** (exit 1 = do not start). The
  docker daemon died mid-round in rounds 3, 4 and 5; round 5's six service-backed targets reviewed
  with no servers at all, so its pre-existing count is a floor. Restart with
  `dockerd &` then `./examples/dev-compose/dev-infra.sh up all`.

  Per-round data and the full writeup live in
  `docs/findings/critical-review/2026-07-29-careening/`. Round N's procedure: re-pin worktrees
  (`node scripts/careening-worktrees.mjs setup <sha>`), then
  `Workflow({scriptPath: ".claude/workflows/careening-review.js", args: {round, quiesced: [],
  changed: [], wakeAll: true}})` — **by scriptPath, never by name**: a named workflow resolves to a
  snapshot registered at session start, and round 3 silently ran the round-1 script that way.

  Then one remediation agent per target, each in its own worktree, staged and uncommitted; the
  orchestrator extracts with `git diff --cached` and commits per package. 14 patches per round have
  applied with zero real conflicts, because targets are disjoint packages. Worktrees exist because
  mutation testing is mandatory and a mutation on a shared tree is another agent's phantom failure.

  **Four defects this experiment created and later found**, worth knowing about because they are
  the substance of the iatrogenesis number: a round-3 helper (`isNoSuchTopicError`) that shipped as
  dead code with all five call sites still on `instanceof`; a round-2 ID-token rule that rejected any
  `nonce` and so permanently 401'd Keycloak deployments the README recommends; a round-3 stream
  incarnation read from cached state, so an unobserved re-provision still minted a duplicate id; and
  a round-2 read-state flush that spread the whole in-memory map over a re-read, clobbering a
  sibling instance's more-advanced cursor. All four passed their own round's tests.

  **And one of a different species, found in round 6: a remediation that never applied.** Round 5's
  nats `tailSequence` repair keyed on `getMessage(stream, {last_by_subj})`, which NATS 2.10 answers
  with "no message found" whenever that subject's newest message has been deleted — confirmed by
  direct probe for deletes of `{12}`, `{11,12}` and `{5..12}`. The repair therefore never fires on a
  real server for the case it was written for; the widening loop has always carried it. The fake
  concealed this by answering from surviving records. Making the fake faithful turned three existing
  window rows from vacuous into real. Count this separately from iatrogenesis: not a defect
  introduced, a fix that was inert from the day it landed.

  **Round 6's dominant theme was fixture fidelity** — five of ten targets found a fake that could
  not express the failure being guarded against. postgres: eleven `vi.mock('pg')` Pool fakes stubbed
  `on: vi.fn()`, so the process-killing `error` event was unraisable by construction. xmpp: the fake
  carried one connection-wide nick, so all three conflict-revert rows passed vacuously. slack:
  `FakeSlack` broadcast every Socket Mode envelope to every socket, while Slack's docs say a payload
  "may be sent to any of the connections" — the README's fanout claim was true in test and false in
  production. zulip: `injectRaw`'s non-comparable ids never reach the read window, so the drop
  assertions pass whether the plugin drops them or never sees them. nats: as above.

  **A live-server failure that was cumulative state, not flake.** matrix conformance degraded 3.4 s
  → 10.3 s → >15 s within one session and started failing 11 of 32 cases: `existingRoom()` joins and
  the fixture never leaves, so the `parley` account's joined-room set grows without bound and every
  `/sync` slows. Recreating Synapse fixed it. The instinct to loosen the timeout would have buried a
  real resource leak in the test fixture.

## Status (pre-review, retained)

- **Phase (consolidation → 1.0-ready):** ✅ Published at **v0.9.0**, `main` green, no open issues
  or PRs. Everything in `TASKS.md` is checked. The current branch closes the gap between what the
  repo *claims* and what it *does*, ahead of a deliberate 1.0 (`docs/1.0-readiness.md`):
  - **All ten backends are runnable.** Every package ships a `parley-<name>` bin. The `backend:`
    config key was parsed and read by *nothing*, so `backend: matrix` ran whatever binary you
    launched — removed and rejected at load. `skip_permissions` got the same treatment: a security
    knob nothing reads is now a load error, not a silent no-op.
  - **CI runs every backend for real** via `dev-infra.sh up all` (redis, nats, postgres, xmpp,
    matrix, keycloak) and **fails if any test file skips itself**. Seven of 57 files used to skip
    on every green build, including the conformance suites for the two largest plugins. Now
    **460 tests, 58 files, none skipped**.
  - Fixed: a raw NUL byte in `bridge-matrix/src/index.ts` made the file `data` to `file(1)` and
    made ripgrep refuse to print matches — the largest plugin was invisible to every grep-based
    search. Now an escape.
  - Fixed: `bridge-net-util` (the shared 429 loop behind five HTTP backends) had zero tests, and
    was the one package missing from `vitest.config.ts`'s hand-written alias map — so its first
    tests silently graded stale `dist/` output and passed against a deliberately broken build. The
    map is now derived from `packages/`.
  - Fixed: read-state is keyed by instance+topic but not by backend, so repointing an instance at
    a different backend replayed a foreign cursor and died deep in a driver. Now an actionable
    error naming the state file.
- **Phase (v0.6):** ✅ **Five more backends landed** — Postgres, Zulip, Discord, Telegram, Slack —
  built by five parallel agents (one per plugin package), integrated serially by the lead. All
  green on the shared conformance suite; **zero `bridge-core` changes** (verified by
  `git diff --stat`). Postgres verified against a live local Postgres 16 (`LISTEN`/`NOTIFY` push,
  advisory-lock-ordered `BIGSERIAL` cursor). Zulip/Discord/Telegram/Slack verified against
  **in-process fakes** of their APIs (no credentials/Docker in this environment; deliberate
  choice, user-approved) — Zulip also has an env-gated `zulip (real)` suite
  (`PARLEY_ZULIP_URL/_EMAIL/_API_KEY`).
- **v0.6 fit-contract caveats (honest):** Telegram is the structural outlier — the Bot API has no
  history endpoint, so `fetchRecent` replays a local JSONL store of *observed* messages (own
  sends + `getUpdates`); **no pre-join backfill, ever**, and one `getUpdates` poller per token
  means the multi-writer conformance case is skipped by design. Zulip topics are mutable
  (membership can drift if messages are moved; ids/cursors survive). Discord/Telegram/Slack are
  hosted SaaS — durability/identity under vendor policy, noted in each class JSDoc. Identity: the
  SaaS backends post as the bot account (`identity` arg informational, same shape as Matrix's
  login caveat).
- **Phase (v1):** ✅ **v1 COMPLETE.** All five backends green on the shared conformance suite; remote
  OAuth mode done. **97 tests across 21 files.** Adding every backend after the first touched
  **zero** `@parley/core` code (verified by `git diff`). The seam held end to end.
- **Backends (all conformance-green):** SQLite (poll) · Redis (`XREAD BLOCK`) · Matrix (Synapse C-S
  API, `/sync`) · NATS (JetStream `consume()`) · XMPP (Prosody MUC + MAM). Matrix + XMPP were
  implemented by parallel agents against live Synapse/Prosody and integrated/re-verified here.
- **Infra note:** servers run via plain `docker run` (no Compose plugin on this host); Synapse
  needed relaxed rate limits + a registered user; the Matrix conformance run uses an opt-in
  `shared_room` to stay under Synapse's per-user room-creation limit (production default =
  room-per-topic). v1-wrap: README/TASKS updated, DESIGN §17 re-scanned (niche still unclaimed).
- **Done (all committed, clean build + 57 tests green):** Task #1 toolchain · S-1..S-4
  scaffold/seam/Message · C-1..C-5 core engine · Q-1..Q-4 sqlite plugin · P-1..P-5 push half +
  reply + headless loopback · V-1 conformance suite · V-2 skill+conventions · V-3 README.
- **v0.1 gate evidence:** (a) `@parley/conformance` green vs `bridge-sqlite` incl. forked
  4-process × 25-post write test; (b) headless loopback green (channel capability advertised,
  push delivered with identifier-keyed meta, reply durable, dedup holds).
- **P-1 channel gate: PASSED** (findings + auth discrepancy recorded below).

## SEAM FREEZE (post-v0.1)

The seam (`packages/bridge-core/src/seam.ts`, `message.ts`) and the conformance suite
(`@parley/conformance`) are FROZEN. Any later need to change them is a ⚠ design smell to surface,
not absorb. Backend skeletons (`bridge-redis/matrix/xmpp/nats`) are pre-scaffolded + registered in
the root tsconfig/vitest so parallel agents touch ONLY their own package dir. Success criterion
for every backend after sqlite: zero `bridge-core` changes; conformance green.

## Toolchain — verified empirically (2026-06-25, Node v26.2.0)

| Choice | Resolution |
|---|---|
| MCP SDK | `@modelcontextprotocol/sdk@1.29.0`. Exports restructured: top-level `./server`, `./client`, `./experimental` + a `./*` wildcard. |
| Import specifiers (confirmed loadable) | low-level `Server` ← `@modelcontextprotocol/sdk/server/index.js`; `McpServer` ← `/server/mcp.js`; `StdioServerTransport` ← `/server/stdio.js`; `ListToolsRequestSchema`/`CallToolRequestSchema` ← `/types.js`; `InMemoryTransport` ← `/inMemory.js`; `Client` ← `/client/index.js`. |
| `Server.notification` | exists, signature `(notification, options?)`; accepts arbitrary `{ method:'notifications/claude/channel', params:{content,meta} }`. Constructor accepts `capabilities.experimental['claude/channel']` + `instructions`. We build core on the **low-level `Server`**. |
| SQLite | **better-sqlite3 12.11.1** loads on Node 26 (prebuilt `.node` present; WAL + busy_timeout + AUTOINCREMENT all work). **node:sqlite `DatabaseSync`** works with no flag — documented fallback behind a 4-method `driver.ts`. |
| zod | `3.25.76` (^3) — aligns with the SDK's zod; one copy in the tree. |
| Tests | vitest 2.x + esbuild run fine; `@parley/*` aliased to each package's `src/` so unit/conformance tests need no pre-build. |
| TS | ESM, `moduleResolution: NodeNext`, `tsc -b` project references. Relative imports use explicit `.js` specifiers (NodeNext). |

## Channel-docs verification gate (P-1) — performed before any push code

Source: live `code.claude.com/docs/en/channels` + `/channels-reference`.

- A channel **is** an MCP **stdio** server (spawned as a subprocess) declaring
  `capabilities.experimental['claude/channel'] = {}` (+ `tools: {}` for two-way) + an `instructions`
  system-prompt string, on the **low-level `Server`**.
- Push = `server.notification({ method: 'notifications/claude/channel', params: { content: string, meta: Record<string,string> } })`
  → rendered to Claude as `<channel source="parley" ...metaAttrs>content</channel>`.
- **META KEYS MUST BE IDENTIFIERS** `/^[A-Za-z_][A-Za-z0-9_]*$/` — **hyphenated keys are silently dropped.**
  Values may contain hyphens. So our meta keys are `topic, sender, cursor, msg_id, mentions, timestamp`
  (never `msg-id`). A runtime regex guard enforces this in `channel-emit.ts`.
- Reply/react tools are **ordinary MCP tools** (arbitrary names) registered via `setRequestHandler`.
- Loaded via `--channels plugin:fakechat@claude-plugins-official`; `--dangerously-load-development-channels`
  bypasses the research-preview allowlist. Requires Claude Code **v2.1.80+** (permission relay v2.1.81+).
- Notifications are best-effort / not acknowledged — matches DESIGN §6 "any notify mechanism can be best-effort."

### ⚠ Discrepancy found (docs win, per CLAUDE.md)

- **Auth:** DESIGN.md §2.2 says "API-key / Console auth is **not** supported for the channel path."
  **Live docs say** channels require "Anthropic authentication through claude.ai **or a Console API key**"
  (not available on Bedrock/Vertex/Foundry). → Following docs: do **not** hard-block on claude.ai-only;
  README/manual checklist states "claude.ai subscription **or** Console API key."

## Open decisions made (reversible; noted inline in code where load-bearing)

- Order is a **plugin guarantee** (fetchRecent returns pre-sorted ascending, exclusive `since`); core never
  compares cursor values. Reconciles DESIGN §6's "orders on cursor" + "cursor opaque to core."
- Per-instance read-state lives in **core** as an atomic JSON file (not the message DB).
- Shared conformance suite is its **own package** `@parley/conformance`.

## v0.2 COMPLETE (R-1..R-6) — verified

Remote/chat mode done: stateless Streamable-HTTP transport (reactive-only) + single-tenant
OAuth 2.1 + PKCE front door (SDK `mcpAuthRouter` + `requireBearerAuth` + a `ParleyOAuthProvider`
with owner-consent gate, DCR, rotating refresh, RFC 8707 audience binding). Verified headlessly
acting as Claude's connector: 401→PRM discovery, DCR, PKCE authorize, owner consent, token, then
post/fetch over MCP. `examples/self-host-remote` reference deploy + README (Anthropic IP allowlist
160.79.104.0/21). 72 tests green; **zero `bridge-core` seam changes** forced by v0.2.

> *(Historical — resolved. The blocker below was hit and cleared once Docker access was granted;
> the "resume" plan it describes has since been fully executed — see "v1 COMPLETE" at the top of
> this file. Kept for the record.)*

## Infra reality for the parallel phase (probed 2026-06-25) — HARD BLOCKER

- **No Docker/Podman daemon; no redis-server/nats-server/prosody/ejabberd/synapse binaries.**
  Network egress works (npm + general fetch OK), BUT **downloading + running external server
  binaries is denied by the sandbox** (nats-server download blocked). So network-backend
  conformance **cannot be verified here** without the user enabling Docker / authorizing binary
  downloads / running servers. Surfaced to the user for a decision.
- Consequence: **network-backend conformance can't run against real servers via Docker here.**
  - **v0.2 Remote/OAuth** — needs NO external server (HTTP+OAuth over the same SQLite). Fully
    verifiable here → doing it first.
  - **v0.3 Redis / v0.5 NATS** — investigate no-Docker paths: `redis-memory-server` (downloads a
    redis binary) and the `nats-server` release binary (single Go binary, downloadable). If they
    run, conformance can be green here.
  - **v0.4 Matrix / v0.5 XMPP** — realistically need a full homeserver/Prosody (Docker). Plan:
    implement the plugin code against the seam + ship dev-compose + README; mark conformance
    "verify on a Docker host" (honest, not silently skipped).

## ▶▶ RESUME HERE — network backends (once Docker is available)

**Context:** v0.1 (`@parley/core` + `@parley/sqlite`, local stdio, catch-up + polling push + reply)
and v0.2 (remote Streamable-HTTP + single-tenant OAuth front door) are done, committed, and green
(72 tests). The seam (`packages/bridge-core/src/seam.ts`, `message.ts`) and `@parley/conformance`
are FROZEN. Both v0.1 and v0.2 required **zero** seam changes.

**Decision taken:** user is installing Docker + docker permissions and rebooting; on resume, build
the 4 network backends and run the shared conformance suite GREEN against real servers.

**Everything is staged for immediate resumption:**
- Backend skeletons exist + compile + are registered: `packages/bridge-{redis,matrix,xmpp,nats}/`
  (stub classes `RedisPlugin`/`MatrixPlugin`/`XmppPlugin`/`NatsPlugin` that throw "not implemented";
  already in root `tsconfig.json` references and `vitest.config.ts` aliases `@parley/redis` etc.).
- Test infra ready: `examples/dev-compose/docker-compose.yml` (redis:7, nats:2.10 -js, synapse,
  prosody w/ MAM) + its README with first-run steps. Redis/NATS are ready-to-`up`; Synapse/Prosody
  have documented one-time setup and need validating on first real run.

**Order (TASKS.md):** v0.3 Redis → v0.4 Matrix → v0.5 XMPP + NATS. **Success criterion for each:
new-plugin-only, ZERO `bridge-core` changes (`git diff` must show none), conformance GREEN.**

**Per-backend recipe (repeat for each):**
1. `docker compose -f examples/dev-compose/docker-compose.yml up <svc>`.
2. `npm install <client> -w @parley/<name>` — clients: Redis→`redis` (node-redis v4, has XADD/
   XRANGE/XREAD BLOCK); Matrix→`matrix-js-sdk`; XMPP→`@xmpp/client`; NATS→`nats` (nats.js, JetStream).
3. Implement the seam in `packages/bridge-<name>/src/index.ts` (replace the stub), mapping:
   - **Redis** (v0.3, FIRST EVENT-DRIVEN): one Stream per topic (key e.g. `parley:{topic}`).
     `post`=XADD (id=cursor, also the backendMsgId); `fetchRecent`=XRANGE `(since`..`+` exclusive;
     `subscribe`=**XREAD BLOCK** loop (genuine events, not a poll timer — this milestone proves the
     event-driven push path, D-2). Store sender/mentions in the stream fields. `resolveIdentity`=convention.
   - **Matrix** (v0.4): room→topic, `sync` token→cursor, sync loop→subscribe, `/messages` history→
     fetchRecent, `m.room.message` send→post, event_id→backendMsgId. Read `elkimek/matrix-bridge`
     first (E2EE/TOFU/mentions). Cross-machine test = M-5.
   - **XMPP** (v0.5): MUC→topic, **MAM**→fetchRecent/cursor (archive id), PubSub/MUC-presence→
     subscribe, message stanza id→backendMsgId. README MUST note MAM required.
   - **NATS** (v0.5): subject→topic (`parley.{topic}`), JetStream **seq**→cursor, durable/ordered
     consumer→subscribe, `getMessage`/consumer fetch→fetchRecent, seq→backendMsgId.
4. Add `packages/bridge-<name>/test/conformance.test.ts` calling `runConformanceSuite('<name>',
   factory)` where the factory connects to the dev-compose server and provides a `freshTopic()`
   (unique key/room/subject per test) + `cleanup()`. `concurrentPost` is optional (N client conns).
5. Run `npm test` → conformance GREEN. Then `git diff --stat packages/bridge-core` MUST be empty.
6. Per-backend README points at the canonical upstream Docker image (not authored here). Commit.

**Conformance contract a backend must satisfy:** stable-unique `backendMsgId` AND monotonic,
in-order, **exclusive-`since`** cursor delivery (fetchRecent returns pre-sorted ascending). Order is
the plugin's guarantee; core never compares cursor values. Dedup is on `backendMsgId`, never timestamp.

**If a backend seems to need a core change → STOP and surface it (the seam is wrong; fix the seam,
not core).** That has not happened in v0.1 or v0.2 and is the design's whole bet.

**Then v1 wrap:** all backends green on the shared suite; READMEs point to upstream Docker (XMPP
notes MAM); re-scan prior art by function (DESIGN §17); update the main README backend table.

## Blocked / needs human

- Real `claude --channels` fakechat loopback (P-5 live half) needs an interactive Claude Code session
  (v2.1.80+, claude.ai/Console auth). Automated substitute = headless InMemoryTransport harness +
  `examples/fakechat-loopback/MANUAL-CHECKLIST.md`. **Still the one open item** — Tier-2 live push
  has never been demonstrated in a real interactive session, and `README.md` says so.
- CI cannot be exercised from a branch without a PR, so `ci.yml` gained a `workflow_dispatch`
  trigger; run it against a ref from the Actions tab.

## Post-v1: presence, block_ms, releases (landed since the v0.6 note below)

- **Releases are automated** (#3, #4, #17, #18): merge to `main` → test gate → `semantic-release`
  picks the bump from the PR title, tags, and publishes all 13 packages in lockstep with provenance
  via OIDC trusted publishing. Two hard-won constraints, both encoded in the workflows: npm 12
  (2026-07-08) stopped building better-sqlite3 under `npm ci`, so the gate runs on Node 22's bundled
  npm and the publish upgrades only to `^11.5.1`; and a pre-merge preflight exists because OIDC
  cannot bootstrap a brand-new package, so a PR adding one would go green then split the registry.
- **Transport on `McpServer`** (#8): migrated off the low-level `Server`.
- **Presence** (#6, #7, #11, #15): one shared reserved topic carries hello/heartbeat/goodbye;
  `parley_list_users` is derived above the seam, so it works on every backend with **no new seam
  method**. Offline-aware roster, instance-scoped liveness, beats advertise `post_topics` reach,
  records versioned. Note it is **on by default and writes to the configured backend** — on a real
  Matrix/Zulip account that is a room created on first beat.
- **71-finding audit remediation** (#16) across core and every backend.
- **`block_ms`** (#21): long-poll on `fetchRecent`, native on nine backends with a generic fallback
  in core for SQLite. The seam gained one optional field and core learned no backend names — a
  capability added *after* the freeze without bending it.

## Post-v1: optional retention/pruning (`retention_days`)

Added an opt-in `retention_days` `backend_config` knob to **sqlite** (background prune timer,
hourly + once at connect), **redis** (rides `XADD`'s own `MINID` trim option — opportunistic, tied
to `post` activity), and **nats** (sets JetStream's native `max_age` at stream-creation time —
first-creator-wins, doesn't retroactively update an existing stream). All three: unset = keep
forever (unchanged default behavior); safe by construction since none of `sqlite`'s `AUTOINCREMENT`
rowid, Redis's stream id, or NATS's stream seq are ever reused, so a cursor minted before a prune
stays valid — a stale reader just gets less history back, never a wrong/duplicate message.
**Matrix/XMPP got docs-only notes** instead of plugin code: their retention is a homeserver feature
(Synapse retention policy + admin-API purge; Prosody/ejabberd MAM `archive_expires_after`), not
something an unprivileged bridge account can enact itself. Zero `bridge-core` changes (fully
inside each plugin's opaque `backend_config`); one new sqlite unit test (96 → 97 tests).

## Post-v1: external OIDC (Keycloak) auth mode for remote/chat

`auth.mode: oidc` in the config now swaps the built-in single-tenant OAuth AS for **delegation to
an external OIDC IdP** (Keycloak is the documented/tested target): Parley becomes a pure resource
server (RFC 9728) — PRM points at the realm issuer, the realm's AS metadata is mirrored at the
resource origin, no /authorize,/token,/register are hosted, and inbound JWTs are validated locally
(`OidcTokenVerifier` via jose: JWKS sig, iss, exp/nbf±skew, aud always; optional scope +
identity gates `allowed_subjects`/`allowed_usernames`/`required_role` restore the single-tenant
posture). `createRemoteAuthApp` dispatches on `cfg.auth.mode`; the built-in path and
`transport/http.ts` are untouched, and jose dedupes to the MCP SDK's own copy (zero new packages).

**Verified:** always-run tests against an in-process fake IdP (12 verifier units + 11 e2e through
the real MCP SDK client + 2 example smokes, 81 core tests total green) and a gated live suite
(6/6) against dev-compose Keycloak 26.3, plus a manual smoke of the example server in oidc mode.
Two live-debugging finds worth remembering: (1) declaring `clientScopes` in a Keycloak realm
import REPLACES the built-in scopes — the throwaway realm defines minimal copies of
basic/profile/roles or tokens carry no `realm_access`/`preferred_username`; (2) messages thrown
from a bearer verifier end up in the WWW-Authenticate header, which rejects non-Latin-1 — keep
them ASCII or every 401 becomes a 500.

**Keycloak caveat (documented prominently in docs/keycloak-integration.md):** Keycloak ignores
RFC 8707 `resource` params, so an **audience mapper** (realm-default client scope, e.g.
`aud: parley-mcp`) is mandatory — without it every token carries `aud: ["account"]` and is
correctly rejected. DCR for Claude's connector additionally needs the realm's anonymous
client-registration trusted-hosts policy configured.
