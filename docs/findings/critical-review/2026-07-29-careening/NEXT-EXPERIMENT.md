# What the next experiment should be

**Status: draft, written at round 16 of 20.** Everything here is derived from rounds 1–15. Rounds
16–20 can sharpen or overturn it, and this file will be updated rather than replaced, with the
overturned parts kept visible. It is written now because the reasoning is easier to check when the
data it rests on is still incomplete and says so.

The meta-goal of Careening was never Parley. It was to produce data good enough to decide what the
*next* experiment is — either a step toward fully automated value delivery, or a precise account of
what prohibits it. This is that decision, stated as falsifiably as the pre-registration was.

---

## The six results a next experiment has to be built on

**1. On a deep surface, the loop does not converge.** Fifteen rounds, zero converged. Blocking
findings never fell below 23 and the band is if anything rising. Quiescence — the mechanism for
retiring a cleared target — **never fired once in fifteen rounds**, because no target was ever
cleared. Ouroboros converged at 21 rounds on a small offline app; that convergence is a property of
that surface, not of the protocol.

This is the load-bearing negative result. *"Review until clean"* is not a termination condition on a
real codebase. Any automated pipeline that waits for it does not terminate.

**2. Both stop rules are equally far away, which answers ouroboros's open question.** It asked
whether a severity-gated rule *under-stops*, having observed one would have fired at R12 against its
acting rule's R21. Here it would not have fired at all. On a deep surface the two rules do not
separate, because blocking findings are exactly what does not run out. A next experiment should not
spend a variable on stop-rule design; it should spend it on a **budget**, which is the only stop
condition the data supports.

**3. Cost per pre-existing blocking defect is the number, and it rises.** 238K, 295K, 234K, 315K
tokens (rounds 7–10), **534K** at round 15. Cost per *confirmed* finding is flat — because the loop
keeps finding its own output — so the headline count actively conceals the decay. By round 13 and 15,
81–83% of all findings are lines the experiment itself last touched.

Anyone budgeting an automated review pipeline should budget in pre-existing blocking defects per
megatoken, and should expect that rate to halve every few rounds.

**4. Critics find well and prescribe badly, and only another agent catches it.** Findings were
reliably real — round 13's 33 blocking findings all reproduced, none spurious. The *remediations*
were not: **29 wrong across rounds 9–15**, at least 14 of 35 in round 15 alone, in eight distinct
failure modes. Every single one was caught by a separate agent re-deriving the fix. **Not one was
caught by the test suite**, including the case where the fixer truthfully reported 948 passing tests
for a fix the fixture made unreachable.

Separating review from remediation, each with its own verification, is the highest-value structural
feature this run discovered. It is not an optimisation; without it the loop lands wrong fixes at a
rate around 40%.

**5. A green suite is not evidence, and the ways it fails are systematic.** The recurring shapes,
each measured more than once: a **fake kinder than the server**, so the guard cannot express the
failure (postgres's `Pool.end` settling with clients checked out; xmpp's fake flagging every page
complete; nats answering `last_by_subj` from deleted records, which made a whole remediation inert
from the day it shipped); a **fix that is ungraded rather than safe**, reported honestly as passing;
and a **test that grades the wrong fix**. Two operator errors of the same class — a mutation regex
that silently matched nothing, so a suite ran green against unmutated code — were nearly accepted as
proof, by the operator whose job was checking for exactly that.

Value delivery gated on "the tests pass" is gated on nothing, unless something adversarially grades
the tests. That something has to be mechanical: both operator errors were caught by
`scripts/verify-mutations.sh` requiring the mutation to have *applied*, not by anyone being careful.

**6. A property worth having is not a lens worth running.** Maintainability and test-hygiene filed
101 findings across ten rounds and produced **zero** blocking findings between them. Test-hygiene was
a lens this run invented, on a concern that was genuinely live — and handing the same concern to the
*fixer* as an instruction changed behaviour in one round, where ten rounds of asking a critic about
it changed nothing. Two of eleven lenses were pure overhead, paid every round for fifteen rounds.

---

## What that implies

The instinct after a run like this is to make the reviewer better. The data says the reviewer is
already the strong part: 899 of 941 findings confirmed through round 10, and the findings that were
filed reproduced almost without exception. What is weak is everything around it — the fixes it
prescribes, the tests that are supposed to hold them, and the absence of any condition under which
it stops.

So the next experiment should hold review roughly fixed and move the machinery around it:

**Budget, not convergence.** Fix a token budget up front and measure pre-existing blocking defects
found per megatoken. This makes the experiment's output a *rate* rather than a verdict, and a rate
is what a decision about automation actually needs.

**Mechanical oracles wherever one exists.** This run produced four and every one earned out:
`git blame` for iatrogenesis, `verify-mutations.sh` for the fixer's central claim, the preflight for
service readiness, and the import graph for the prime directive. Every one caught something judgment
missed, and two caught the operator. The pre-registered worry was that reviewer and fixer are the
same model family, so a shared blind spot stays invisible; oracles are the only instrument in this
run that did not share it.

**Fixture fidelity as a first-class gate.** The most expensive defect class here was invisible to
every round that preceded it, because the fake could not express the failure. A next experiment
should test fakes against real servers *as a scheduled activity*, not as something a critic might
get to.

**Drop the two null lenses, and test the conversion.** Move maintainability and test-hygiene out of
the critic and into the fixer's instructions. If the round-4 effect reproduces — behaviour changing
immediately where a lens changed nothing for ten rounds — that is a transferable result about where
to put a quality concern, and it is cheap to run.

---

## What would prohibit fully automated value delivery, precisely

Stated as narrowly as the evidence allows, because a vague version of this is worthless:

1. **There is no stopping condition.** Not "convergence is expensive" — there isn't one. Fifteen
   rounds produced no cleared target and no round below 23 blocking findings.
2. **The system cannot grade its own fixes.** ~40% of prescribed remediations were wrong, none
   caught by the suite, all caught by a second agent. An automated pipeline without an independent
   re-derivation step lands them.
3. **The tests it writes to protect its fixes are the same artifact class it is bad at.** Ungraded
   fixes, unfaithful fakes and tests grading the wrong fix all passed every mechanical check the
   pipeline had, until a mechanical check was built specifically for them.

None of the three is a model-capability limit; all three are missing instruments. That is the
optimistic reading, and it is the one the data supports — with the caveat that each instrument built
so far was built *after* the failure it catches was observed, which is not a strategy that scales to
the failures nobody has hit yet.

---

## Known limits of this reading

- **N=1, twice.** Careening is run #2 of the protocol, on a deliberately harder substrate, and three
  variables moved at once (surface, partition, lens count). Nothing here separates them.
- **Reviewer and fixer are the same model family**, so a shared blind spot is invisible to everything
  except the four oracles.
- **The same session authored the substrate these critics reviewed.** Fresh contexts per critic
  mitigate; they do not eliminate.
- **Rounds 16–20 are not in.** In particular, the pre-existing-blocking series sitting at 6 twice is
  the only evidence for exhaustion in the whole run, it rests on two points, and both are floors
  inflated by decomposition-relocation blame.
