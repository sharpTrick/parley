---
name: critical-review
description: Run one round of Parley's Careening adversarial review — one all-lens critic per package, full-surface, structured findings, computed convergence — then fix, ratchet, and repeat. Use when asked to review the codebase adversarially, run a review round, drive to convergence, or continue the Careening experiment. Not for reviewing a single diff or PR.
---

# Critical review (Careening)

The operator's guide. The process is `docs/REVIEW_PROTOCOL.md`; the reviewer is
`.claude/agents/critic-package.md`; the runner is `.claude/workflows/careening-review.js`. Read the
protocol before your first round — the anti-patterns in it are all things that have already gone
wrong somewhere.

## Run a round

```
Workflow({ name: "careening-review", args: { round: N, quiesced: [...], changed: [...], wakeAll: false } })
```

- `round` — the round number, for labels and the record.
- `quiesced` — pass back the previous round's `nextQuiesced` verbatim.
- `changed` — `git diff --name-only <last-round-sha>..HEAD`. This drives wake-up.
- `wakeAll` — **required for any round that may declare convergence.**

Round 1: no args. Every critic runs, nothing is asleep yet.

## Read the result

| field | what to do with it |
|---|---|
| `converged` | `true` only from a wake-all round with zero CONFIRMED. Two consecutive → done. |
| `blockingClean` | The **shadow** signal. Record it; do **not** act on it. |
| `counts` | confirmed / blocking / plausible / total. |
| `confirmed` | The work list. Fix or explicitly justify every one. |
| `plausible` | Adjudicate: fix, or write down why not. Doesn't block convergence. |
| `nextQuiesced` | Pass straight back in as the next round's `quiesced`. |
| `byLens` | Per-lens yield — the experiment's primary measurement. |
| `byTarget` | Per-critic counts, plus `checked` for the ones that found nothing. |

## Remediating a round

Past the first few findings, do **not** fix them inline. Fan out one remediation agent per package,
hand it that package's findings, and keep the orchestrator's context for adjudication and the
commit. A round can produce a hundred findings; reading each one's code into a single context is
what forces a mid-run compaction, and an orchestrator that has forgotten round 3 cannot notice that
round 9 is re-finding it.

Each remediation agent gets: the findings for its package, the fix cycle below as its contract, and
instructions to report back what it fixed, what it declined and why, and which mutation it watched
fail. It must not touch another package — parallel agents editing shared files is how a round
corrupts its own baseline.

The orchestrator then adjudicates the declines, runs the full suite once, and writes the commit.

## The fix cycle

1. **Verify before fixing.** The critic already traced it, but confirm independently — a wrong fix
   is worse than a missed finding, and it manufactures work for the next round.
2. **Fix every CONFIRMED finding, or adjudicate it in the commit message.** No silent skips, and no
   arguing back through the codebase: a declined finding is recorded in the commit that closes the
   round — weak, or outweighed by X — never as a comment or a doc paragraph aimed at the next
   reviewer. The critic's job is to convince you; yours is to decide.
3. **Ratchet the THEME into the suite, not the instance.** A parameterized case or a widened
   generator that would also catch inputs nobody tried. In the prior run, 87 of 92 findings wore
   distinct class labels but collapsed to ~12 themes, and 8 themes came back under fresh labels
   because the tests locked exact tuples. Before writing the test, ask: *what would the same defect
   look like wearing different clothes, and does my test catch that too?*
4. **Prove the test works.** Reintroduce the defect and watch the new test fail, then restore.
   A test that passes both with and against the bug is guarding nothing — this has already happened
   twice in this repo, once because the assertion checked a property no user sees, and once because
   the package under test was missing from the vitest alias map, so the suite graded a stale build.
5. **Run the whole suite** with real servers up (`./examples/dev-compose/dev-infra.sh up all`), not
   just the package you touched.
6. **Commit,** then start the next round from that commit.

## Stopping

The acting rule is **two consecutive wake-all rounds with zero CONFIRMED**. A round that changed
code resets the counter — you owe at least one more full round that changes nothing.

The round budget (20) is a **checkpoint for a human decision, not a stop rule.** On reaching it,
report and ask; do not silently stop or silently continue.

Never stop on "diminishing returns" or because a fix looked trivial. Do not let a quiesced critic
stand in for a clean one — convergence needs `wakeAll: true`.

## Recording the run

Every round's returned object is data for the experiment. Persist it under
`docs/findings/critical-review/2026-07-29-careening/data/` as it goes; reconstructing a run from
transcripts afterwards is how the prior experiment ended up with a headline number that was a
post-hoc hand-label rather than a measurement.

Per round, keep: `round`, `converged`, `blockingClean`, `wakeAll`, the counts, `ranTargets`,
`quiescedTargets`, `byLens`, `byTarget`, and every finding. Also record tokens, tool calls and
wall-clock, so cost-per-finding is computable rather than estimated.

Two derived measurements are the point of this run, and both must come from an oracle rather than a
judgment call:

- **Iatrogenesis.** For each finding, `git blame` its `file:line` against the experiment's own
  commit range: was that line introduced by a Careening fix? Compute it; do not label it by hand.
- **Quiescence recall loss.** In each wake-all round, any finding in a package that was quiesced
  *and unchanged* is a recall miss caused by retirement. Count them.
