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
Workflow({ name: "careening-review" })
```

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

