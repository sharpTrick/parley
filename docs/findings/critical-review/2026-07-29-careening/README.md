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

*(To be appended as rounds complete. Nothing here yet — the run has not started.)*
