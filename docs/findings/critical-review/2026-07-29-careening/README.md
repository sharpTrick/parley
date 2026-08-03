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
| 4 | 14 / 14 | 120 | 113 | 45 | 7 | 0 | no |
| 5 | 14 / 14 | 129 | 117 | 39 | 12 | 0 | no |
| 6 | 14 / 14 | 90 | 86 | 26 | 4 | 0 | no |
| 7 | 14 / 14 | 79 | 75 | 23 | 4 | 0 | no |
| 8 | 14 / 14 | 73 | 71 | 25 | 2 | 0 | no |
| 9 | 14 / 14 | 71 | 68 | 28 | 3 | 0 | no |
| 10 | 14 / 14 | 75 | 72 | 29 | 3 | 0 | no |
| 11 | *decomposition round — no review* | | | | | | — |
| 12 | *decomposition round — no review* | | | | | | — |
| 13 | 15 / 15 | 84 | 82 | 33 | 2 | 0 | no |
| 14 | *decomposition round — no review* | | | | | | — |
| 15 | 15 / 15 | 111 | 109 | 35 | 2 | 0 | no |

Three rounds ran no critics. Rounds 11, 12 and 14 are **decomposition rounds** — the simplify-first
rule described in `docs/REVIEW_PROTOCOL.md`, splitting single-file packages after `bridge-sqlite`
(the one already-decomposed package) recorded 4 blocking findings across rounds 6–10 against a mean
of 9.6 for the monoliths. They change the substrate rather than measuring it, so they carry no
findings row and they break the round-to-round comparison on either side of themselves.

**Round 13 and round 15 are not comparable to each other, or to round 10, in the direction one would
want.** Round 13 followed two decomposition rounds; round 15 was the first round under the staged
review (a critic loops back when it can *name* a gap in its own coverage). Blocking went 29 → 33 →
35 while total findings went 75 → 84 → 111. A rising count is exactly what a more thorough search
looks like and exactly what a worsening codebase looks like, and a single round cannot separate them.
The instrument changed under both; that ambiguity is recorded in each round's summary rather than
resolved by picking the flattering reading.

**Round 5 is degraded and its numbers should carry an asterisk.** The docker daemon died during the
round, so the six service-backed targets (redis, postgres, matrix, xmpp, nats, core-auth) reviewed
against source and fakes only — the postgres critic reported all nine of its server-gated files
self-skipping, and matrix reported the same. The findings are real code findings, and the mutations
run against non-server cases are valid, but defects that only a live server surfaces could not appear.
Given round 4's result that a real server is worth more to a critic than another round, this makes
round 5's pre-existing count a FLOOR rather than a measurement. Verification was pushed into
remediation instead, where every agent reproduces against live services before fixing.

Round 3 ran the **round-1 runner** — see "Process defects" below. It is kept in the series because
all 14 critics still reviewed the correct targets full-surface and reached the worktrees and the
mutation requirement through `docs/REVIEW_PROTOCOL.md`; but it is a protocol-version confound and
any cross-round claim has to say so.

Tests in the suite after each round's remediation: **460 → 1428 → 2545 → 3926 → 5241**, none
skipped, against real Redis, NATS, Postgres, Prosody, Synapse and Keycloak.

That series is itself a finding. The suite grew **11.4×** across four rounds while the count of
pre-existing defects found per round fell (100 → 73 → 52). Round 4 added 1315 tests to find 52
things that were wrong before the experiment started. Some of that growth is real coverage of real
gaps — the `node:sqlite` fallback driver had none at all, and Discord's fakes checked neither
authentication nor capability bits — but the ratio is the cost the next experiment has to answer for.

Round 4 was also the first round where agents **deleted** tests as well as adding them, once the
prompt told them to prefer it: bridge-nats shed 29 rows from one file while covering strictly more,
bridge-sqlite deleted 16, and bridge-redis replaced 9 hand-picked rows with 6 generated ones. Nothing
in rounds 1–3 was ever removed. Test-hygiene as a *lens* produced 7–9 findings a round and zero
blocking ones; test-hygiene as an *instruction to the fixer* changed behaviour immediately. That gap
between measuring a property and asking for it is the most actionable thing in this dataset.

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

Round 4 (total / confirmed / blocking): test-integrity 31 / 31 / **12**, concurrency-and-failure
16 / 15 / 10, security 15 / 14 / 8, design-principles 11 / 11 / 3, truth-in-docs 9 / 8 / 2,
test-hygiene 9 / 9 / 0, protocol-conformance 8 / 6 / 2, correctness 8 / 7 / **6**, maintainability
6 / 5 / 0, operability-and-release 4 / 4 / 1, seam-integrity 3 / 3 / 1.

**test-integrity holds first place for a second round** (31 findings, 12 blocking) — it is now the
lens the loop runs on, which is the same statement as the iatrogenesis figure from a different angle.
**Security recovered** (8 → 15 findings, 4 → 8 blocking), which weakens the round-3 reading that it
was decaying: the difference is that round 4 was the first round to execute the committed protocol,
including the rule letting each critic stand up its own throwaway container. Postgres, matrix and
xmpp critics each ran against a private server this round and verified against live behaviour rather
than a fake. On a surface like this, **giving a critic a real server is worth more than another
round.**

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

### Per-lens yield over ten scored rounds

Rounds 1–10 are the clean comparison window — one partition (14 targets), one instrument, no
decomposition in between. `total` findings and `blocking` of them, summed:

| lens | findings | blocking | rate |
| --- | ---: | ---: | ---: |
| concurrency-and-failure | 145 | 92 | **63%** |
| security | 118 | 61 | **52%** |
| correctness | 113 | 55 | 49% |
| protocol-conformance | 61 | 27 | 44% |
| test-integrity | 225 | 91 | 40% |
| seam-integrity | 13 | 4 | 31% |
| design-principles | 94 | 16 | 17% |
| truth-in-docs | 111 | 13 | 12% |
| operability-and-release | 50 | 4 | 8% |
| test-hygiene | 55 | 0 | **0%** |
| maintainability | 46 | 0 | **0%** |

**Two of eleven lenses filed 101 findings across ten rounds and produced not one blocking finding
between them.** Maintainability replicates ouroboros exactly on the half that mattered. Test-hygiene
— a lens this run invented — did the same thing, which is the more useful result, because it was
added on the theory that vacuous and duplicated tests were a live risk on this substrate. They were.
The lens simply was not how to reach them: the same concern handed to the *fixer* as an instruction
changed behaviour in a single round (round 4, where agents deleted tests for the first time — nats
shed 29 rows while covering strictly more). A property worth having is not automatically a lens worth
running, and the cost of finding that out was a lens-round every round for the whole run.

**concurrency-and-failure is the highest-yield lens on this surface at 63% blocking**, ahead of
security. That ordering is the substrate talking: eleven backends with reconnect, paging and
multi-process paths give it more to work with than any other lens has.

### What the pre-registered expectations look like after fifteen rounds

The round-2 reading is kept below it, unedited, so the two can be compared.

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

#### The same five, scored against rounds 1–15

- **E1 (security stays productive) — CONFIRMED.** Ouroboros's security lens went silent from R11 to
  R21. Here it filed 4–6 blocking findings in *every* round through 10 and 10 findings in round 15,
  at a 52% blocking rate over the window. The deep-surface hypothesis is the one pre-registered
  expectation that came out cleanly.
- **E2 (maintainability files the most, blocks the least) — HALF CONFIRMED, and the half that failed
  is informative.** Zero blocking findings in ten rounds, exactly as predicted. But it filed 46
  findings, 5% of the total, against ouroboros's 43%. The per-lens partition is the likely cause: a
  critic with only maintainability to report reports maintainability, whereas an all-lens critic that
  has just found a lost wakeup files that instead. If that is right, ouroboros's *"convergence was
  gated by maintainability running out of nits"* is substantially an artifact of partitioning by
  lens, and this run's partition is what exposes it.
- **E3 (cost per confirmed finding rises) — CONFIRMED, on the denominator that matters.** Per
  *confirmed* finding it is flat (~30–38K tokens, rounds 7–15) because the loop keeps finding its own
  output. Per **pre-existing** finding it rises: 88K, 83K, 99K, 133K (rounds 7–10) and 160K at round
  15. Per pre-existing *blocking* finding: 238K, 295K, 234K, 315K, **534K**. The decay is real and it
  is invisible in the headline count.
- **E4 (quiescence cuts tail cost and loses recall) — UNTESTABLE, and that is the result.**
  Quiescence has **never fired in fifteen rounds**. Every target returned confirmed findings every
  round, so nothing was ever eligible to sleep. The pre-registered question was *can a review loop
  safely stop looking at what it has already cleared?* On a surface this deep, nothing ever gets
  cleared. The efficiency mechanism is inert and its recall risk is moot — a more useful answer than
  a tuned threshold, and it stays clean only because the threshold was never tuned.
- **E5 (the blocking-gated rule fires earlier) — CONTRADICTED, and this is the sharpest answer this
  run gives to ouroboros's open question.** Ouroboros asked whether a severity-gated stop rule
  *under-stops*, having noted it would have fired at R12 against its acting rule's R21. Here it
  **would not have fired at all**: blocking findings never reached zero in any of eleven scored
  rounds, and the band 23–35 is if anything rising. The two rules have not separated because neither
  is close. On a deep surface, severity-gating buys nothing, because blocking findings are what the
  loop does not run out of.

Four of five pre-registered expectations resolved; the fifth resolved by refusing to be testable.
None of them was retrofitted — the wordings above answer the wordings written before round 1.

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
| 4 | 120 | 68 | 52 | **57%** |
| 5 | 129 | 77 | 51 | **60%** |
| 6 | 90 | 72 | 18 | **80%** |
| 7 | 79 | 52 | 27 | **66%** |
| 8 | 73 | 40 | 32 | **56%** |
| 9 | 71 | 45 | 26 | **63%** |
| 10 | 75 | 56 | 19 | **75%** |
| 13 | 84 | 69 | 14 | **83%** |
| 15 | 111 | 86 | 20 | **81%** |

Round 1 is not gradeable — there was no prior experiment commit for a line to be attributed to.

The oracle is `scripts/iatrogenesis.mjs`, committed at round 16. It had been an ad-hoc computation
until then — an unreproducible instrument measuring reproducibility — and it was committed only
after it reproduced rounds 2–10 exactly, including the blocking-only split below. Findings whose
`file:line` does not exist at the base commit are reported as unresolvable rather than guessed: one
in round 13, five in round 15.

### The number that actually moved: pre-existing **blocking** findings

Total iatrogenesis mixes suggestions with the findings that gate the stop rule. Restricting the same
oracle to CONFIRMED-and-blocking asks the sharper question — *is the loop still finding things that
matter in the original codebase, or only in its own output?*

| round | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 13 | 15 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pre-existing blocking | 36 | 25 | 20 | 11 | 5 | 10 | 9 | 11 | 8 | **6** | **6** |

Round 6's fall to 5 looked like the knee ouroboros reported. It was not: rounds 7–10 recovered to a
stable 8–11 band, which is what the halfway reading recorded as *"no knee at the run level."*

Rounds 13 and 15 are the first two consecutive rounds below that band — and they land on the **same
value from very different total finding counts** (84 and 111), under two different instruments, on a
substrate that had just been restructured. That is the strongest exhaustion signal this run has
produced.

It is also two points, and both are **floors**. Rounds 11, 12 and 14 relocated large amounts of code;
`git blame` reports the last touch, so a line a split merely moved is charged to the experiment. The
self-induced share is inflated by an unknown amount and the pre-existing counts can only be too low.
What would settle it is round 16 onward, against a tree nobody is restructuring.

The trend is the result, and by round 4 it is unambiguous: **the share of findings the loop created
for itself is rising** — 26% → 39% → **57%** — while the absolute count of pre-existing findings
falls, 100 → 73 → 52. Round 4 is the first round where the loop spent more of its effort on its own
output than on the original codebase. That is ouroboros's two-regime split, reproduced on a much
deeper surface and arriving at round 4 rather than round 11 — and it arrives while the *blocking*
count goes UP (38 → 45), so this is not the loop running out of things to say. It is the loop
becoming its own subject.

Cost, for the same round: 2.11M review tokens for **52 pre-existing findings**, i.e. ~40K tokens per
pre-existing defect for review alone, and roughly double once remediation is counted. That number,
not the round count, is what a decision about a next experiment should be built on.

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
