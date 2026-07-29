# Careening — adversarial review partitioned by package

**Status: pre-registered, run in progress.** Everything below the line was written *before* round 1
and will be reported as stated regardless of how it comes out. Results will be appended, not
substituted.

**Why "Careening."** Careening is beaching a ship and heeling it over to expose the hull below the
waterline — the only way to see the rot, and impossible to do underway. You stop sailing in order to
inspect. That is exactly the trade this loop is measuring, and reviewing package by package is
inspecting the hull one section at a time.

---

## Pre-registration

### Question

Ouroboros (ringweave, 2026-07-24) ran an adversarial review to convergence and found that the loop
spent its second half reviewing its own output at ~3× the cost per finding, with one user-visible
bug to show for it. Its own *"what would change our mind"* section named the counterfactuals, and
this run hits several of them deliberately:

> **A different app surface.** This app is small, offline, client-side, no network/auth/server. The
> early saturation of the security lens is partly a property of that surface. A larger app with a
> genuinely deep security/correctness surface might keep the diagnostic lenses productive far
> longer, moving the knee right on its own.

> **A different stop rule.** "Zero confirmed" is one of many. A severity-gated or value-gated rule
> would have registered "done" at ~R12 and never entered the tail; whether that under-stops […] is
> the open question.

> **Repeat runs.** N=1. […] the two-regime split and the iatrogenesis ratio would need a few more
> runs to be trusted as general rather than incidental.

Parley is that deeper surface: ten network backends, OAuth 2.1 and OIDC, concurrency and reconnect
paths, a frozen protocol seam, thirteen published packages.

### Design

| Variable | Ouroboros | Careening |
|---|---|---|
| Partition | 4 agents, one **per lens**, one component | 14 agents, one **per package**, all lenses each |
| Reviewer | Opus, effort medium | Opus 5, effort medium |
| Surface | `app/` — offline, client-side, no network/auth | 13 packages — network, auth, concurrency, protocol |
| Stop rule (acting) | 2 consecutive zero-CONFIRMED rounds | **same** |
| Round budget | ran to 21 | **20, then a human decides** |
| Lens set | 4 | **10** (5 Parley-specific) |
| Cleared reviewers | re-ran every round | **quiesced until a dependency changes** |
| Iatrogenesis label | post-hoc hand-label | **mechanized via `git blame`** |

**Three variables move at once** — surface, partition, and lens count. That is a real confound. The
writeup must say so plainly and must not attribute any delta to a single cause; per-package and
per-lens tagging is what allows partial decomposition afterwards.

### Pre-registered measurements

Reported whatever they show:

1. **Findings per round**, split confirmed / blocking / plausible — the decay curve.
2. **Cost per confirmed finding**, per round, in subagent tokens. Ouroboros: ~47K in its discovery
   era, ~143K in its tail.
3. **Per-lens yield.** Ouroboros: correctness 29% blocking, security 36%, maintainability 5% (43%
   of all findings, zero sole-source blocking), solid 4%. The specific hypothesis: *security
   saturated in ouroboros because that app had no network or auth surface, and will not saturate
   here.*
4. **Both stop signals.** The acting rule is two consecutive zero-CONFIRMED wake-all rounds. The
   round at which a **blocking-gated** rule would have fired is recorded and never acted on — this
   answers ouroboros's open question from a single run at no extra cost.
5. **Iatrogenesis, mechanized.** For each finding, `git blame` on its `file:line` against the
   experiment's own commit range decides whether that line was introduced by a Careening fix.
   Ouroboros's `66.7% self-induced` was, in its own corrections, "a hand-label […] reported to three
   significant figures over a ±1–2-finding judgment call, and it was coded by the same agent that
   authored the fixes." This is the same quantity from an oracle.
6. **Theme recurrence.** Distinct `class` labels vs. distinct `theme` labels, and how many themes
   recur across ≥3 rounds under new class labels. Ouroboros: 87 of 92 findings wore distinct
   classes, collapsing to ~12 themes, 8 of which recurred; one concern wore 11 labels.
7. **Quiescence economics.** Tokens saved versus a full-fan-out counterfactual, and — the honest
   other half — **recall loss**: any finding a wake-all round surfaces in a package that was
   quiesced *and unchanged* is a recall miss caused by retirement.

### Falsifiable expectations

Written down so they can be wrong:

- **E1.** Security will *not* go extinct the way it did in ouroboros (silent from R11 to R21). Deep
  auth surface.
- **E2.** Maintainability will again file the most findings with the fewest blocking ones — i.e. the
  low-yield result replicates on a different codebase and a different partition.
- **E3.** Cost per confirmed finding will rise monotonically-ish across rounds, replicating the
  decay independent of partition.
- **E4.** Quiescence will cut tail cost substantially **and** lose some recall; the wake-all rounds
  will surface at least one finding in a package that had gone quiet.
- **E5.** The blocking-gated stop rule will fire meaningfully earlier than the zero-CONFIRMED rule,
  reproducing the gap ouroboros observed (R12 vs R21) rather than closing it.

An outcome contradicting any of these is a finding, not a problem with the run.

### What is being reviewed

The Parley monorepo at the head of `claude/next-steps-q1540r`, immediately after a consolidation
pass that made all ten backends runnable, put every backend into CI for real, and reconciled the
docs with the code. That consolidation is the substrate; the review is the experiment.

Baseline going in: **460 tests across 58 files, none skipped**, with real Redis, NATS, Postgres,
Prosody, Synapse and Keycloak running.

### Known limitations, stated up front

- **N=1 again**, on a different codebase and a different partition. This makes ouroboros's
  conclusions *more* testable, not confirmed.
- **The confound above** — three variables moved.
- **The reviewers and the fixer are the same model family**, so a shared blind spot stays invisible.
  Ouroboros's conclusion was that the missing instrument "has to be an instrument that doesn't share
  the operator's blind spot." Two of this run's ten lenses (seam-integrity, truth-in-docs) are
  mechanically checkable, and two of its measurements (iatrogenesis, quiescence recall) come from
  oracles rather than judgment — but the review itself is still model-graded.
- **Self-review of the substrate.** The same session authored the consolidation these critics are
  reviewing. Fresh contexts per critic mitigate; they do not eliminate.

---

## Results

Appended as rounds complete. Raw per-round data is in `data/`.

### Per round

| round | targets run | findings | CONFIRMED | blocking | PLAUSIBLE | errored | converged |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | :-- |
| 1 | 14 / 14 | 139 | 124 | 61 | 15 | 0 | no |
| 2 | 14 / 14 | 136 | 130 | 49 | 6 | 0 | no |
| 3 | 14 / 14 | 119 | 115 | 38 | 4 | 0 | no |

Round 3 ran the **round-1 runner** — see "Process defects" below. It is kept in the series because
all 14 critics still reviewed the correct targets full-surface and reached the worktrees and the
mutation requirement through `docs/REVIEW_PROTOCOL.md`; but it is a protocol-version confound and
any cross-round claim has to say so.

Tests in the suite: **460 → 1428** (round 1 remediation) **→ 2545** (round 2 remediation), none
skipped, against real Redis, NATS, Postgres, Prosody, Synapse and Keycloak.

### Per-lens yield (total / confirmed / blocking)

| lens | R1 | R2 |
| --- | --- | --- |
| concurrency-and-failure | 29 / 25 / 17 | 24 / 23 / 16 |
| design-principles | 9 / 9 / 3 | 23 / 23 / 5 |
| test-integrity | 16 / 16 / 7 | 21 / 21 / 10 |
| security | 23 / 17 / 9 | 15 / 13 / 9 |
| correctness | 19 / 18 / 13 | 11 / 10 / 3 |
| truth-in-docs | 15 / 13 / 3 | 11 / 10 / 2 |
| maintainability | 4 / 4 / 0 | 11 / 11 / 0 |
| protocol-conformance | 12 / 12 / 9 | 8 / 8 / 4 |
| test-hygiene | *(not yet added)* | 7 / 7 / 0 |
| operability-and-release | 11 / 9 / 0 | 5 / 4 / 0 |
| seam-integrity | 1 / 1 / 0 | 0 / 0 / 0 |

Round 3, same order of columns (total / confirmed / blocking): test-integrity 28 / 28 / **12**,
truth-in-docs 18 / 17 / 1, concurrency-and-failure 17 / 17 / **13**, correctness 11 / 11 / 3,
security 8 / 8 / 4, test-hygiene 8 / 8 / 0, operability-and-release 8 / 7 / 0, design-principles
7 / 7 / 1, protocol-conformance 6 / 6 / 2, seam-integrity 4 / 2 / **2**, maintainability 4 / 4 / 0.

Three movements are worth naming now rather than at the end:

- **test-integrity went from fourth to first (28 findings, 12 blocking).** Round 2's remediation
  took the suite from 1428 to 2545 tests, and round 3 found most of its blocking material *in that
  new test code*. The loop is now substantially reviewing its own output — the regime change
  ouroboros reported at its midpoint, arriving here at round 3 rather than round 11. The `git blame`
  oracle is what will settle how much; it has not been run yet.
- **security is decaying: 23 → 15 → 8 findings.** E1 predicted a deep auth surface would keep this
  lens productive. It is still producing blocking findings (9, 9, 4), so it has not gone extinct the
  way ouroboros's did — but the trend is downward and E1 should not yet be called confirmed.
- **seam-integrity produced its first blocking findings (2).** Both are the same shape: core
  depending on something the seam does not guarantee. `computeRoster` keys the presence roster on
  `Message.senderHandle`, which the conformance suite explicitly makes optional and which five of
  ten backends do not carry; and `bridge-sqlite` silently clamps `limit` to 1000 while core's
  catch-up driver uses a short page as its "topic exhausted" signal, so `catchup.limit: 1500`
  silently strands every message past the first thousand. The prime directive (core must not import
  a backend) holds and was checked mechanically every round; what these findings show is a subtler
  leak in the other direction — core relying on behaviour the seam never promised.

### What the first two rounds say about the pre-registered expectations

Two rounds is far too few to settle any of these. Recorded now so the reading is not
retrofitted later.

- **E1 (security stays productive).** Holding so far — 9 blocking findings in each of the first two
  rounds, no sign of the extinction ouroboros saw. This is the expectation the deep surface was
  chosen to test, and it is the one currently most clearly supported.
- **E2 (maintainability files the most, blocks the least).** *Contradicted on the first half,
  confirmed on the second.* Maintainability filed 4 and 11 findings, nowhere near ouroboros's 43%
  of the total — but it produced **zero** blocking findings in both rounds, exactly as predicted.
  The likely cause of the first half is the partition, not the codebase: a per-lens critic with only
  maintainability to report will report maintainability, whereas an all-lens critic that has just
  found a lost wakeup files that instead. If that reading is right, ouroboros's "convergence was
  gated by maintainability running out of nits" is partly an artifact of partitioning by lens.
- **E5 (blocking-gated rule fires earlier).** No signal yet; both rounds are far from either stop
  rule.
- **E3, E4.** Not yet measurable — no round has quiesced, and cost-per-finding needs more points.

### Iatrogenesis, measured rather than estimated

`data/iatrogenesis.json`. For each round, `git blame` is run **at that round's base commit**, at each
finding's `file:line`, asking whether that line was last touched by a commit authored inside the
experiment. Deterministic, and computed by something that does not share the fixer's blind spot —
which was the pre-registered upgrade over ouroboros's `66.7%`, a post-hoc hand-label applied by the
same agent that wrote the fixes being judged.

| round | findings | self-induced | pre-existing | % self-induced |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 136 | 36 | 100 | **26%** |
| 3 | 119 | 46 | 73 | **39%** |

Round 1 is not gradeable — there was no prior experiment commit for a line to be attributed to.

The trend is the result: **the share of findings the loop created for itself is rising**, 26% → 39%,
while the absolute count of pre-existing findings falls (100 → 73). That is the loop working as
intended on the original surface and progressively turning on its own output — consistent with the
test-integrity lens jumping to first place in round 3, and with ouroboros's two-regime split, but
arriving much earlier here.

Two caveats that cut against over-reading it. Line-granularity blame attributes the **last** touch,
so a round that reformats or moves a line without introducing the defect is charged with it — this
over-attributes. And a finding anchored on a *test* rather than on the code it guards is attributed
to whoever wrote the test, which is usually the previous round. Both push the number up. It is a
ceiling, not a point estimate.

One methodological note recorded because getting it wrong is easy: the first run of this oracle
blamed at `HEAD` instead of at each round's base, which credited later remediation commits with
earlier findings and reported round 2 at 51% instead of 26%. The line numbers in a findings record
are only meaningful against the tree the critic read.

### Mid-run decisions, and what was deliberately NOT changed

Recorded because "we did not change the instrument" is only credible if the moments we could have
are written down.

At round 3, with the round costing ~4.3M tokens and iatrogenesis at 39%, the operator was presented
with the projected cost of rounds 4-20 (~70M tokens) and offered three stop rules and three ways to
cut per-round cost. **Both pre-registered mechanisms were kept unchanged:**

- **Stop rule stays zero-CONFIRMED, running to the round-20 checkpoint** — not the blocking-gated
  shadow rule, which would very likely fire within a few rounds. Comparability with ouroboros's
  acting rule was judged worth more than the tokens. The shadow metric continues to be recorded, so
  the "would a severity-gated rule under-stop?" question is still answered by this run, from the
  data rather than from a decision.
- **Quiescence stays as specified**, and its null result is the finding. Three rounds in it has
  **never fired**: all 14 targets returned confirmed findings in all three rounds, so no target has
  ever been eligible to sleep. The pre-registered question was *can a review loop safely stop looking
  at what it has already cleared?* On a surface this deep the answer so far is that **nothing ever
  gets cleared** — which makes the efficiency mechanism inert and its recall risk moot. That is a
  more useful result than a tuned threshold would have been, and it only stays clean because the
  threshold was not tuned.

The fan-out (14 targets) was likewise left alone.

### Instrument observations

- **`theme` is not being used as designed.** 136 findings carried **100 distinct themes**. The field
  was added because ouroboros's 92 findings wore 87 distinct *class* labels but collapsed to ~12
  themes, and the ratchet locked cases rather than themes. At near-1:1, `theme` is being filled in at
  class granularity and cannot yet serve as the anti-recurrence barrier it was introduced to be. This
  is a defect in the instrument's *instructions*, not in its data collection — recorded rather than
  fixed mid-run, per the pre-registered rule on not changing the instrument.
- **`seam-integrity` yielded 1 finding in R1 and 0 in R2.** The prime directive is holding, which is
  the substantive result; but it also means the mechanically-checkable lens contributes almost
  nothing to the stop signal. Whether that is saturation or a lens with nothing left to say on a
  frozen seam is not yet distinguishable.
- **A round's cost is dominated by remediation, not review.** Both rounds ran 14 critics in
  parallel; both took substantially longer to *act on* than to *produce*. Ouroboros measured review
  cost; the thing that actually gates throughput here is the fan-out of fixers behind it.

### Process defects found by running the process

Recorded because the meta-goal is what the *next* experiment should be.

- **The runner received `args` as a JSON string**, so `round` silently defaulted to 1 and `wakeAll`
  to false. Since `wakeAll` is a precondition for declaring convergence, round 2 was
  convergence-INELIGIBLE and a clean round could not have stopped the loop. Fixed in `128ce60` and
  recorded as a protocol-version bump; no round's findings were affected, only its eligibility.
- **Agents sharing a filesystem corrupted each other's work.** Three round-1 remediators collided on
  one scratch path and wrote foreign plugin source into packages. Round 2 gave every agent its own
  git worktree (`scripts/careening-worktrees.mjs`), which fixed it.
- **Worktrees isolate files, not services.** Shared Synapse contention produced 4 *false* conformance
  failures in round 2 — foreign traffic in the shared `parley_conformance` room legitimately advances
  the Matrix cursor, which the suite's stability assertion cannot distinguish from a defect. Both the
  matrix critic and the orchestrator diagnosed this independently and it passed 18/18 once quiet. The
  harness sharing one stable room across processes is a real defect, filed for a later round.
- **`git checkout -- <file>` is a trap in a dirty worktree.** Three separate agents used it to undo a
  mutation and destroyed their own uncommitted fixes. The remediation contract now says to snapshot
  and restore from the snapshot.
- **A named workflow is a snapshot, and the snapshot went stale.** Round 3 was invoked as
  `Workflow({name: "careening-review"})` and executed the round-1 script: no worktree instruction,
  no mutation-testing requirement, no container-scoping rule, and none of the argument parsing fixed
  in `128ce60` — so it recorded itself as "round 1, not convergence-eligible" despite running all
  fourteen critics. The findings stand, because `CLAUDE.md` points critics at
  `docs/REVIEW_PROTOCOL.md` and they picked up the worktrees and the mutation requirement from
  there; the instrument's redundancy is what saved the round. The runner, protocol and skill now all
  say to invoke by `scriptPath`. This is the second time the same class — *the harness silently ran
  something other than what was committed* — has cost a round its convergence eligibility.
- **A guard nobody watched fail.** Round 1's remediation reintroduced a raw NUL byte into a source
  file, which made `file(1)` classify it as binary and ripgrep skip it silently. It recurred four
  times before being ratcheted as a class in `source-hygiene.test.ts` — the clearest example in this
  run of why the protocol requires ratcheting the class, not the instance.
