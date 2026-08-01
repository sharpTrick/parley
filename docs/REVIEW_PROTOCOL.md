# Adversarial review protocol

The authoritative process for Parley's adversarial critic review. `.claude/agents/critic-package.md`
defines the reviewer, `.claude/workflows/careening-review.js` is the executable runner, and
`skills/critical-review/SKILL.md` is the operator's guide. This file governs the *process*.

Adapted from `ringweave`'s protocol, which was measured to convergence in the **ouroboros**
experiment (2026-07-24, 21 rounds, 92 findings, ~5.26M tokens). Where this file departs from that
one, it says so and why — those departures are the experiment.

## The problem it addresses

Both humans and agents have blind spots when implementing, plus self-approval bias: a working
solution is so much better than nothing that it is hard to see the bugs, over-complication and debt
inside it. Code review is the standard mitigation — a fresh, context-free pair of eyes. But an
*initial* review has blind spots too, finding `m` issues and leaving `n − m`. So: keep reviewing the
full surface with fresh contexts, ratcheting each fix into the suite, until reviews come back clean.

## The loop (non-negotiable)

1. **Full-surface, every round.** Point each reviewer at the *whole package it owns*, never a diff.
   Reviewers anchor on the first or biggest issue they see; a diff-scoped review hides everything
   the anchor is sitting on top of.
2. **One reviewer per package, all lenses each.** Ouroboros partitioned by *lens* — four critics,
   one lens apiece, over one component. Careening partitions by *package*: each reviewer owns one
   package and carries all ten lenses. This is the experiment's main variable.
3. **Verify before acting.** Reproduce or trace every finding against the code. `CONFIRMED` only
   when traced or reproduced; otherwise `PLAUSIBLE`.
   **Adjudication lives in the commit message.** A finding may be declined — weak, or correct in
   isolation but outweighed. Say so in the commit that closes the round, never as a comment or a
   doc paragraph written at the next reviewer. The critic's job is to convince; yours is to decide.
4. **Ratchet the class into the suite before closing.** Codify the *class* — a parameterized case or
   a widened generator — not the one input, so a later reviewer finds it already guarded.
5. **Keep going until a round changes nothing substantive.** Convergence = a full round yielding
   **zero CONFIRMED findings**. Clearing an anchor frees a reviewer to find the next layer, so a
   clean round only counts *after* the last round that changed code.

## Simplify first (from round 11)

Rounds 1–10 were purely accretive. Source roughly doubled per backend — redis 307 → 826 lines,
xmpp 674 → 1325 — and almost none of it went into new files: nine of ten backends still carried a
single `index.ts` over 900 lines, matrix's at 1499. The one package that had been split, `bridge-sqlite`
(11 files, biggest 632), recorded **4 blocking findings across rounds 6–10 against a mean of 9.6** for
the monoliths, on an unremarkable total finding count. Same volume of findings, far less of it serious
— the shape you would expect if a monolith hides interaction defects while a decomposed package has
only local ones left. n=1 and sqlite is also the simplest backend, so it is suggestive, not proof.

Round 11 is therefore a **decomposition round** and rounds 12–20 carry a standing simplify-first rule.
This is a deliberate regime boundary, recorded so the two halves can be compared: rounds 1–10 are the
protocol against monoliths, rounds 12–20 the same protocol against decomposed code. If the hypothesis
holds, blocking findings per package should fall.

**The rule: a round must be net-negative on SOURCE lines.** Source is `packages/*/src/**` excluding
tests. It deliberately does NOT cover tests — every confirmed finding must be ratcheted into the
suite, so a total-lines quota would either stop the ratchet or push agents to delete tests to buy
headroom. Test growth is governed instead by the test-hygiene lens, which asks for instances collapsed
into parameterized classes: `bridge-telegram` did exactly that in round 9, going 527 → 523 tests while
coverage rose from 4 fields to 9 and from 15 breakage cells to 37.

**Imports do not count against the net.** A multi-file split pays roughly 30-70 lines of import
ceremony per package (measured: 459 lines across the eleven decomposed packages, 3% of source).
That is real but it is not logic, and counting it made round 11's margins misleadingly thin — xmpp
landed at -3 and shared at -5 where the non-import deltas were -36 and -13. Measure the net over
non-import source lines.

**Architectural tests are fair game, under the standing rule in `CLAUDE.md` §"Architectural tests:
assert the invariant, not the layout" — never let one drive a structural choice; move or replace it.**
That rule is not scoped to decomposition rounds; it governs every change to this repository, and
`CLAUDE.md` is its authority. Round 11 is where it came from: six ways a path- or shape-coupled
assertion had cemented the monoliths — a split blocked, a guard hollowed out while staying green, a recorded security debt made
invisible, a private field's TYPE asserted, a lint with a hole, and a probe a refactor turns into
`expect(undefined).toBeUndefined()`. Every one was individually justified when written.

So a structural assertion may be rewritten to be location-independent: glob `src/**` instead of one
path, assert the invariant instead of the field's shape. It may be DELETED only if the agent NAMES
where that invariant is already covered behaviourally, and shows that named test failing against the
defect it is supposed to catch. "It blocked the split" is not a reason. `bridge-redis`'s reader
accounting is the model of a legitimate delete: the invariant it guards — no live socket survives
teardown — is already asserted externally through the proxy in `live-failure-modes.test.ts`.

**Do not move source and behavioural tests in the same round.** The unmodified-suite rule is the
whole proof that a decomposition preserved behaviour, and it only means something if the suite is
held still. Architectural tests are the sole exception, and only under the rule above.

**Appeals are allowed and must carry data.** An agent that cannot land net-negative may appeal in its
report with a specific argument — the measurement that shows the added lines close a defect class no
smaller change reaches, or the deletion that would lose functionality worth keeping. "It needed more
code" is not an appeal. The orchestrator adjudicates and records the outcome in the commit message.

**Decomposition is behaviour-preserving, and the suite proves it.** A split lands only if the existing
tests pass **unmodified**. If a test has to change, the move was not behaviour-preserving — that is a
finding, not a merge conflict to resolve. A pure-move refactor is precisely where a silent behaviour
change hides, which is why the unmodified-suite rule is the whole guarantee.

**One measurement consequence, stated up front.** `git blame` attributes a moved line to the commit
that moved it, so the iatrogenesis oracle will read rounds 12+ as near-100% self-induced unless it
blames through moves (`-C -M`). The oracle is re-anchored for that; where it cannot be, the
discontinuity is reported rather than smoothed.

## The `repo` target (added at round 13 — a partition change, recorded as one)

Rounds 1–12 ran a 14-target partition, every target scoped to one package or two. Round 13 adds a
fifteenth, `repo`, owning what is true of the repository and structurally invisible to a
package-scoped critic: cross-package duplication, the coverage matrix of a repo-wide invariant,
lockstep drift between sibling packages, build/CI/release plumbing, root-level doc claims, and tests
in one package that assert on another's source by path.

**This changes the experiment's main variable mid-run, and that cost is real.** Per-round finding
counts are no longer strictly comparable across the round-12/13 boundary, and the writeup must
report the discontinuity rather than smooth it. Two things justify paying it. First, the loop
itself filed this theme in rounds 3, 3, 4 and 5 — `identical-helper-restated-per-test-file`,
`per-file-copies-of-the-liveness-probe-and-fixtures`, `per-file-restated-harness-and-duplicate-case`,
`per-file-rig-duplication` — and never closed it, because a critic that owns one package can see an
instance but never the class. A fifteenth package-scoped round would not have surfaced it a fifth
time either. Second, the theme is measurable rather than aesthetic: ten `cli.ts` copies at ~545
lines with ten distinct hashes and already-drifted comments, one helper byte-identical in six files,
and nine repo-wide invariants covering 32 of 104 package-cells.

**Scope discipline is the point, and it is in the brief.** The `repo` critic is told that fourteen
others are reading one package each in parallel and that a defect confined to one package is theirs,
not its — package-local code is admissible only as *evidence* for a repo-scale pattern, where the
pattern is the finding. It carries the lenses that operate at that scale (design-principles,
test-integrity, test-hygiene, truth-in-docs, operability-and-release, maintainability,
seam-integrity, and security only where repo-scale) rather than all eleven, and it does not start
containers. It wakes on any change, since any change can break a cross-package invariant — including
a change to a file no package target claims.

**Report its yield separately.** A finding only this target could reach is the measurement that says
whether partition-by-package was leaving a whole class unreachable; folding its findings into the
per-package series would hide exactly that.

## Quiescence (a Careening addition)

A reviewer that returns zero CONFIRMED findings **quiesces** and sits out later rounds. It wakes
when — all derived mechanically from `package.json` dependency edges and `git diff --name-only`,
never from judgment:

- its own package changed;
- a package it depends on changed (`@sharptrick/parley-core` wakes everything;
  `@sharptrick/parley-net-util` wakes the five HTTP backends; `@sharptrick/parley-conformance` wakes
  every backend);
- the seam or the shared theme registry changed.

This targets ouroboros's clearest measured waste: its security critic returned "nothing found" for
nine consecutive rounds while every round still cost ~300K tokens.

**Two guards, because quiescence can corrupt the stop signal.**

- **Convergence requires a wake-all round.** A quiesced package is a missing lens, and a missing
  lens cannot produce a clean signal. Both terminal zero-CONFIRMED rounds must run every reviewer.
  Quiesce through the productive middle; never quiesce into a declaration of done.
- **Retirement is a recall bet, so it is measured.** Reviews are stochastic — ouroboros's confirmed
  count ran `1 → 3 → 1 → 4 → 3 → 3 → 3` across rounds 13–19, finding things in code that had not
  changed. Any finding a wake-all round surfaces in a package that was quiesced *and unchanged* is
  a recall miss attributable to retirement, and is reported as such.

## Isolation: what an agent owns, and what it must not touch

Every agent — critic or remediator — gets a **git worktree of its own**, pinned to the round's base
commit (`scripts/careening-worktrees.mjs`). That makes "full-surface at commit X" structural rather
than a matter of the orchestrator's discipline, and it makes mutating source safe, which is what
lets mutation-testing be required below.

Worktrees isolate an agent's *repository*, and **not** the scratchpad. Every concurrent agent is
handed the same scratch directory, so a backup written there under an obvious name — `index.ts.bak`
— is a filename two agents will pick independently. In round 7 they did: the Matrix agent restored
its backup and got **bridge-slack's source into `bridge-matrix/src/index.ts`**, and the Postgres
agent hit the mirror image of the same collision. Both caught it and recovered from git, but a run
that did not would have committed one package's implementation into another.

So: **scratch files go under a per-target path** (`/tmp/careening/<target>-scratch/`), never the
shared scratchpad, and never a bare name in a shared directory.

**Never `git stash` in a worktree.** The stash stack lives in the COMMON git dir, so worktrees do not
isolate it — it is the same trap one level down. In round 8 the Postgres and core-auth agents each
stashed to measure a baseline; a sibling pushed between one agent's push and its pop, and each `pop`
restored the *other's* work into the wrong worktree. Both recovered from dangling stash commits, but
a run that did not notice would have committed one package's implementation into another.

**And `git checkout -- <file>` is a mutation restorer only for a file you have not otherwise
edited.** Three round-8 agents used it to undo a mutation and wiped their own in-progress fix along
with it, because it restores from the index or HEAD — which, in a worktree pinned to the round base,
is the code *before* the remediation. Either `git add` the fix first, so the index holds it, or keep
a per-target copy of the fixed file and `cp` it back. This paragraph previously said the worktree
"is a git checkout, so `git checkout --` restores it", which is the reasoning that produced all
three losses.

**This bites the ORCHESTRATOR in the main repo too, and knowing the rule is not enough.** In round
12, verifying a re-anchored assertion meant mutating an applied-but-uncommitted decomposition and
restoring it — and `git checkout -- <file>` took `index.ts` back to the round base, discarding a
792→353 split, while the new sibling files survived untracked and typechecked against the old one.
The recovery is `git show :<path>` from the source worktree, whose index still holds the staged
version. The habit that prevents it: `cp` the file aside before mutating, `cp` it back after, and
never reach for `git checkout --` while anything in the tree is uncommitted. Mutation-and-restore
is the single most common thing done to uncommitted code here, so it is where this hazard lives.

**Create worktrees with `scripts/careening-worktree.sh <dir> <base>`; never `npm install` per
worktree, and never plain-symlink `node_modules` either.**
Fifteen worktrees each installing the same tree cost **1.7 GB against 148 MB** — the same dependency
set copied fifteen times, all of it reconstructible from `package-lock.json`. Verified equivalent
rather than assumed: `bridge-net-util`'s 682 tests pass unchanged through the symlink. The naive fix — symlinking `node_modules` at the main
checkout — is wrong in a way that stays SILENT, and shipping it cost a round-13 agent real work.
npm workspaces put ABSOLUTE symlinks at `node_modules/@sharptrick/*`, so a symlinked worktree
resolves every sibling package to `/home/user/parley/packages/*`: an agent editing two packages sees
only one of its own edits, and `tsc -b` reports errors belonging to a tree it is not working in.
That is precisely how one agent came to report a repo-wide typecheck failure that did not exist.

The script hard-links instead (files share inodes, so the disk cost stays nil) and then RE-POINTS
every workspace link at the worktree, which makes it hermetic. Verified: a repo-wide `tsc -b` passes
inside one, and `@sharptrick/parley-net-util` resolves to the worktree's own `packages/`.

**What is actually known about the container dying, as opposed to guessed.** It has restarted three
times mid-run. `uptime` is the instrument that settles it — it read `up 5 min` against `up 3:45`
earlier the same day, so the container is being **reprovisioned**, not corrupted and not rolled back
in place. Measured at the time: 23 GB of disk free (not exhausted), no single oversized file, **no
swap configured**, 4 cores, and 16 GB of RAM. Two of the three deaths followed a fan-out launched
with the Agent tool directly, which is **uncapped** — nine concurrent agents drove load average to
47 with `kswapd0` at 20%, and with no swap that pressure has nowhere to go. `Workflow` is not the
same risk: it caps concurrency at `min(16, cores - 2)`, which on this host is **2**.

So prefer `Workflow` over a hand-rolled parallel Agent fan-out for anything package-wide, and when
launching agents directly, launch a few at a time. The rest is not preventable from inside the
container, which is why the recovery discipline below is what actually protects the work.

**Staged work in a worktree is not durable — extract and commit it the moment an agent reports.**
The worktrees live under `/tmp`, so a container restart takes every uncommitted patch with it. In
round 9 one agent finished, staged 13 files, and died before reporting; the restart then rolled the
worktree back and its whole round was gone, while the thirteen targets already extracted and pushed
survived untouched. Do not batch extraction to the end of a round.

**A rolled-back container looks exactly like data loss, and the local repository cannot tell you
otherwise.** After that same restart the local `HEAD`, the reflog, `git cat-file` on every later
commit, and even the worktree pins all agreed that four rounds had never happened — because all four
are reads of the same rolled-back filesystem, including `origin/<branch>`, which is just a file
under `.git/refs/remotes/`. Only `git ls-remote` asks the remote. It showed the branch exactly where
it had been pushed, and `git fetch` + `git reset --hard` restored everything. Three consistent
readings from one instrument are not corroboration; check the one source the failure could not have
touched before concluding anything is lost.

Worktrees isolate the filesystem and **not** the backing services. A shared Redis, Postgres,
Synapse, Prosody, Keycloak and NATS are one destructive test away from taking down every concurrent
agent, and even without that, contention produces false reds — the NATS outage tests passed alone
and failed under full-suite load purely because reconnect took longer while the rest of the suite
hammered the same server.

So an agent **may stand up its own throwaway containers**, under three rules:

- **Only for the backend it owns.** A sqlite agent has no business starting Redis; a Slack agent has
  no business starting Synapse. If a finding seems to need another backend's service, it is a
  finding about the seam or about the other package — escalate it, do not provision your way around
  it.
- **Never touch a container it did not create.** The shared `parley-dev-*` set belongs to the
  orchestrator. Use a distinct name and a distinct published port, so nothing collides with the
  shared instance or with a sibling agent.
- **Tear down what you start,** and say in your report what you started and that it is gone.

Reuse the image and flags from `examples/dev-compose/docker-compose.yml` rather than inventing a
recipe — that file is the canonical setup, and a divergent one tests something the project does not
ship.

## The services being up is a precondition, and it is CHECKED

Run `node scripts/careening-preflight.mjs` before launching a round; a non-zero exit means the round
must not start. It verifies the docker daemon and that all six services answer on loopback.

This exists because the daemon died mid-round three times in five rounds, and each time the critics
carried on without their servers and reported it only in prose — where the operator finds it after
the round has already been paid for. Round 5's six service-backed targets reviewed against source and
fakes alone, which makes its pre-existing-defect count a floor rather than a measurement.

A round that LOSES the services partway cannot be detected by a preflight. If a critic reports a
missing service, the round is degraded: say so in the data, and treat its pre-existing count as a
lower bound rather than re-running it, unless the tokens are cheaper than the uncertainty.

## The test suite's green state is GIVEN

The suite is green before a round is launched; that is a precondition, not a question. **Do not
re-run it to confirm it passes** — a green suite tells you nothing you were not already told.

Run tests only as an *instrument*:

- to **reproduce** a hypothesised defect (this is the CONFIRMED bar), or
- to **mutate** the code and prove an existing test is vacuous.

The second is the highest-value technique available and it is **expected**, not optional, for the
`test-integrity` lens. Round 1's single best finding came from mutating one backend six ways and
watching the frozen conformance suite stay green through all six — including a class that had
already bitten a shipped backend. Ask of any test you rely on: *what mutation would keep this
green?*

## Anti-patterns — proven failure modes, do NOT do these

- ❌ **Diff-scoping a follow-up round** to "only what changed since last round." A narrow round
  confirms your fix while missing what the earlier anchors sat on top of.
- ❌ **Dropping a lens because a package "obviously" doesn't need it.** The lens set is the
  instrument; a partial instrument produces an unreadable measurement.
- ❌ **Treating a round that CHANGED code as the clean round.** A substantive fix *resets* the
  clean-round counter; you owe at least one more full round that changes nothing.
- ❌ **Stopping on "diminishing returns" or a fixed round count.** The budget is a checkpoint for a
  human decision, not a stop rule.
- ❌ **Quiescing into convergence.** See the guards above.
- ❌ **Ratcheting the instance instead of the class.** Ouroboros's fourth finding: 87 of 92 findings
  wore distinct class labels but collapsed to ~12 themes, and 8 themes recurred across ≥3 rounds
  under *new* labels — one concern wore 11. The point tests passed while the theme walked around
  them.

## Convergence is computed, not judged

Run the committed runner rather than orchestrating by hand — it enforces full-surface and
per-package coverage, collects structured output, applies the wake rules, and computes convergence:

```
Workflow({ scriptPath: "<repo>/.claude/workflows/careening-review.js",
          args: { round, quiesced, changed, wakeAll } })
```

**Invoke it by path, never by name.** A named workflow resolves to a copy registered when the
session started, so edits to the runner do not reach a `name:` invocation. Round 3 ran the
round-1 script this way — without the worktree instruction, the mutation-testing requirement,
the container-scoping rule, or the argument parsing that records `wakeAll`. The critics still
reached the first two through `docs/REVIEW_PROTOCOL.md`, which `CLAUDE.md` points them at, so
the round's findings stand; but a round whose `wakeAll` is not recorded can never declare
convergence, which is the failure this note exists to prevent.

It returns `converged` (**true iff zero CONFIRMED findings in a wake-all round**), the
confirmed/blocking/plausible counts, per-package and per-lens breakdowns, and the findings.
**You are done only when a run made *after* your last code change reports `converged: true`, twice
in a row.**

## Structured findings

| field | meaning |
| --- | --- |
| `severity` | `blocking` \| `suggestion` |
| `verdict` | `CONFIRMED` (traced/reproduced) \| `PLAUSIBLE` (needs adjudication) |
| `lens` | which of the ten lenses produced it — the yield measurement |
| `theme` | coarse slug above `class`; ratchet the theme, not just the class |
| `class` | kebab slug of the finding *type* |
| `file`, `line` | anchor |
| `summary` | one-sentence defect |
| `failure` | concrete input → wrong output / hang |
| `remediation` | the fix |
| `testUpgrade` | the parameterized/fuzz test guarding the *class* |

`CONFIRMED` blocks convergence. `PLAUSIBLE` is surfaced for adjudication (fix, or justify why not)
but does not by itself keep the loop open.

## The ten lenses

Every reviewer carries all ten, every round it runs, and tags each finding with the one that found
it. Ouroboros's per-lens blocking rates are given where a lens carries over — they are the prior
being tested, not a reason to skip anything.

1. **correctness** *(29% blocking in ouroboros)* — cursor arithmetic, off-by-one, contract
   violations, and whether the tests would actually catch the failure you hypothesize.
2. **concurrency-and-failure** — Parley's historically richest surface. Lost wakeups,
   subscribe-readiness races, reconnect and rejoin, partial failure, multi-process safety, orphan
   cleanup. One lost-wakeup shape appeared in four backends wearing four disguises.
3. **security** *(36% blocking)* — inbound-as-untrusted, topic allowlist and anchored `post_topics`,
   secret handling, the OAuth/OIDC surface (PKCE, RFC 8707 audience binding, RFC 9728 PRM), and the
   channel meta-key identifier guard. Unlike ringweave's offline app, this surface is deep — which
   is the direct test of ouroboros's "security saturated because the app had no network or auth."
4. **seam-integrity** — the prime directive, and the checkable form of lens 5's OCP/DIP. Core must
   never import a backend; dependencies point one way. Mechanically testable via the import graph
   and `git diff --stat packages/bridge-core`.
5. **design-principles** *(4% blocking)* — SOLID scoped as **SRP + OCP + light DIP** (not all five;
   Liskov/ISP dogma manufactures architecture-astronaut findings in TypeScript), plus **KISS** and
   **YAGNI**. Bidirectional by design: flag gratuitous patterns, indirection, and abstraction with
   only one variant as firmly as missing ones — an OCP lens without a YAGNI brake *generates* the
   speculation it is meant to prevent. Extended with the **principle of least astonishment**
   (behavior a reasonable user would not predict is a defect even when the code is correct,
   documented and never fails), **fail-fast / no silent no-ops** (Parley's signature defect class),
   and **compatibility discipline** (additive fields vs. a version bump). *Deliberately not
   adopted:* Postel's law — for a protocol seam, strictness is the virtue.
6. **protocol-conformance** — cursor monotonicity, exclusive-`since`, dedup on `backendMsgId` and
   never on timestamp, ordering as a plugin guarantee, `NoSuchTopicError`.
7. **test-integrity** — does the test test the thing? Fakes that cannot reproduce real-server
   semantics, guards that silently never fire, suites that skip themselves into a false green,
   assertions on a property users never see.
8. **truth-in-docs** — every public claim (README, DESIGN, `package.json` descriptions, tool
   descriptions, JSDoc) matches the code.
9. **operability-and-release** — bin/exports/files wiring, publish preflight, whether CI verifies
   what it claims, npm metadata.
10. **maintainability** *(5% blocking; 43% of all ouroboros findings)* — dead code, duplication,
    stale names, unclear APIs, and **comment discipline** (`CLAUDE.md`): a comment earns its place
    only by warning a future developer off a risky action, phrased as *"keep X, so that Y."* A
    comment restating the code, narrating history, justifying a choice, or addressed to a reviewer
    is a finding — and where a comment exists because the code is unclear, the finding is against
    the *code*, not the comment. Kept deliberately as the **control arm**: ouroboros concluded
    convergence "was gated by maintainability running out of nits, not by the app becoming correct
    and secure." Whether that replicates on a deep surface is a finding, not an assumption.
11. **test-hygiene** *(added at round 2; instrument v2)* — the suite's own reviewability. Round 1
    took it from 460 tests to 1428 in a single pass, and a suite no human can review is a suite no
    human is checking. Distinct from `test-integrity`, which asks whether a test tests the thing:
    this asks whether the suite stays legible. Cases differing only in a literal are one
    parameterized case. A table earns its rows only if each dimension can independently fail — ask
    which row would survive deleting the others. Fakes and builders restated per file are drift
    waiting to happen; share the fixture or say why not. A failing test name should locate the
    defect without opening the file. A case that costs seconds and discriminates nothing is a
    finding, because slow suites get skipped and a skipped suite is a lie. More assertions are not
    more coverage: flag a case that pins what its neighbour already pins. File against the *suite*,
    not the feature — if your fix is "add another test", it belongs under a different lens.

