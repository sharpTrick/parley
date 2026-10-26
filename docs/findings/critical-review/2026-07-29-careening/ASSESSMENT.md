# Careening, assessed — strengths and weaknesses of the 21-round process

**Status: written 2026-10-25, after the series merged to `main` as sharpTrick/parley#22.** It draws
on all 21 rounds (`README.md`, `data/`), round 21's remediation (the commit messages of
`claude/round21-remediation`, squashed into `7bce79e`), the single regression pass over that
remediation, and the first three CI runs the series ever had. Where it disagrees with
`NEXT-EXPERIMENT.md` (written at round 16), this file is later evidence. That file stays as written.

The question here is narrower than the pre-registration's. It is not *"does the loop converge?"*,
which is answered (no). It is: **what did 21 rounds do well enough to keep, what did they do badly
enough to change, and which of those is backed by a number?**

---

## In brief

- **The review finds real defects, reliably, for as long as you run it.** 899 of 941 findings were
  confirmed in rounds 1–10, and 180 of 188 in round 21. At least **239 blocking defects that
  predated the experiment** were found: 61 in round 1 and 178 graded across rounds 2–21. The
  self-induction oracle over-attributes, so 178 is a floor.
- **The loop never stops on its own, and spends most of its effort on its own output.** None of the
  18 scored rounds converged (three of the 21 were decomposition rounds), and quiescence never fired
  once. The self-induced share sat at 74–91% for the last
  nine scored rounds. In round 21, 21 of 23 graded blocking findings fell on lines the experiment
  last touched.
- **Fixes are the weak artifact, and the test suite does not catch bad ones.** Wrong prescriptions
  rose to 59% of blocking findings by round 19. Round 21's 28 fixes carried **7 defects**, all
  invisible to a green suite and all caught by one independent regression pass.
- **The process never met its production environment until the end.** CI did not run once between
  2026-07-21 and the PR, across 576 commits. The first two CI runs each failed on a different defect.
  Both had survived every round, and one was a false premise written in round 1.
- **The machinery that worked is mechanical.** Mutation replay, the `git blame` oracle, the skip
  gate, the diff guard, and giving critics real servers. Everything judgment-based (prescriptions,
  premises, "this comment is true") is where the misses are.

---

## Strengths

### S1. Findings are real, and they keep coming

| measure | value |
| --- | --- |
| confirmed / filed, rounds 1–10 | 899 / 941 (96%) |
| confirmed / filed, round 21 | 180 / 188 (96%) |
| blocking findings in any scored round | never below 23 |
| pre-existing blocking, round 1 | 61 |
| pre-existing blocking, rounds 2–21 (oracle floor) | 178 |

Round 13's 33 blocking findings all reproduced; none was spurious. A critic rarely invents a defect.
The yield did not decay to zero either. The pre-existing blocking count settled into a band
(**36, 25, 20, 11, 5, 10, 9, 11, 8, 6, 6, 10, 4, 1, 8, 6, 2**), at roughly 300K review tokens per
defect from round 7 on. Round 1 found an owner-auth bypass and two ReDoS paths in core. Round 21
still found a 30-day `Retry-After` retried 1 ms later, Redis echoing a truncated password into an
error, and Discord able to exhaust its 1000-IDENTIFY daily quota.

### S2. Giving a critic a real server is worth more than another round

Security went from 8 to 15 findings, and from 4 to 8 blocking, in round 4. That was the first round
in which critics stood up their own throwaway Postgres, Matrix and XMPP servers. Round 5, when the
docker daemon died, is the counter-case: six targets reviewed against fakes only, so its count is a
floor. Several of round 21's best findings needed the real thing: Redis 7's byte-budgeted echo
grammar, Prosody's nameprep, Zulip's commit order read from its own server source, and Node's timer
wrap at 2³¹−1.

### S3. Separating review from remediation is the highest-value structure the run found

A critic's *finding* is reliable and its *prescription* is not. 89 prescriptions (±5) were wrong
across rounds 9–19, at a rate rising from 18% to 59% of blocking findings. None was caught by a test
suite; all were caught by a separate fixer re-deriving the fix. Round 21 adds at least two
demonstrably wrong prescriptions:
- **r21-114:** the token bucket's 24 h bound breaches Discord's quota from N=280 inside the accepted
  domain.
- **r21-038:** a requested whole-string pass is itself a credential leak when two echoes overlap.

The remediation contract's first line, *"treat `remediation` as a hint, not a spec"*, is what kept
those out.

### S4. Mechanical oracles caught what judgment missed, including the operator

- **`scripts/verify-mutations.sh`** requires a guard to go red when its defect is reintroduced. It
  twice caught an operator accepting a mutation that had matched nothing. In this session it also
  showed an equivalent mutant for what it was, rather than a hole: listening for Disconnect instead
  of Reconnect in `cdb2e47`.
- **The `git blame` oracle** (`scripts/iatrogenesis.mjs`) replaced a hand-label with a deterministic
  measurement. Its first run, blamed at `HEAD`, was wrong, and the method note says so.
- **The skip gate** went from "a describe group ran" to "every case ran or declared a capability"
  (`8312eaf`). It now catches a failed account seed that silently became a skip.
- **The remediation diff guard** caught surface widening the suite could not see. Round 21's Discord
  fix had made `identifiesPerWindow` a required member of the exported `DialBudget`, which would
  break every external literal (`5937ada`).

### S5. "Run it, don't scan it" became the default, and it found more

From round 19 on, guards were built by executing the thing rather than pattern-matching its text:
- a real `tsc` against a pruned install;
- a real `setTimeout` for the timer ceiling;
- every YAML block in every root document run through the real loader.

The pruned-install compile found **12 of 13** published `.d.ts` failing for a consumer, where the
finding had named one. The YAML run found that DESIGN.md's only complete config example did not
load. Cases settled by executing something rose from 9% to 63% of disproved prescriptions between
rounds 16 and 19.

### S6. Ratcheting the class produced durable, generated guards

The protocol's demand to "ratchet the class, not the instance" produced tests that cover a space
rather than a point. Round 21 examples:
- Redis's bordered-credential table: reverting the strike reddens 66 rows.
- Discord's 36 simulated hours of reconnect-ladder failure patterns, graded against the real quota.
- NATS's sparse-history table crossed with every page limit.
- Slack's seeded property table of redelivered and reordered envelopes across a socket rotation.

The suite went from 460 tests to 20,836, none skipped except three declared capabilities.

### S7. The record corrects itself in the open

The pre-registration was honoured: five expectations, scored against the wordings written before
round 1. When the data overturned a claim, the claim stayed visible beside its correction. That
happened four times: the exhaustion signal, the cost trend (E3), the prescription mode-shift, and
round 8's blocking count. `COMMIT-CORRECTIONS.md` does the same for commit messages that
under-described their diffs. That makes the dataset trustworthy enough to reuse.

---

## Weaknesses

### W1. There is no stopping condition, and the loop becomes its own subject

None of the 18 scored rounds converged, and quiescence never retired a target. The self-induced share was 26%
at round 2, crossed 50% at round 4, and sat between 74% and 91% from round 13 to round 21. Round 21
is the extreme: 155 of 171 graded findings, and 21 of 23 graded blocking ones, fell on lines the
experiment last touched. That is a ceiling, since blame charges the mover and the September
simplification moved a great deal. The stop rule was designed for a codebase under review. What
actually existed was a codebase under continuous reconstruction, which the instrument cannot measure
for exhaustion.

### W2. A green suite does not grade a fix, so fixes ship with defects

Round 21's remediation is the cleanest measurement of this in the run. Every one of its 28 fixes
passed:
- its own package tests;
- a mutation proof;
- the diff guard;
- the full suite.

A single regression pass by fresh reviewers then found **7 defects in 5 of those 28 fixes (18%)**:

| fix | defect the fix introduced or left |
| --- | --- |
| r21-038 redis | struck the encoded spelling first, so a shared 8-char opening leaked the decoded tail |
| r21-139 telegram | `find(… !== undefined)` stopped at `message: null` and dropped the channel post |
| r21-075 xmpp | `toLowerCase` is not nameprep's full case fold (ß, final σ admitted) |
| r21-075 xmpp | a quadratic fold ran before the size limit: ~10 s to refuse 32k chars |
| r21-137 telegram | a per-module registry could not see a same-pid holder in another module instance: two writers |
| r21-015 core | two `parley_live_status` limits (documented and shipped, by maintainer decision) |

The suite did not catch one of the seven. This is NEXT-EXPERIMENT's result 4, reproduced on the
remediation of the remediation.

### W3. The process never ran in the environment it ships to

CI triggers on pull requests and pushes to `main`, and has a manual `workflow_dispatch`. The series
lived on a branch for three months and never used it. **Zero CI runs between 2026-07-21 and
2026-10-25**, across 576 commits and 740 files. Every round's gate ran on the operator's machine.

The first CI run failed. So did the second, on a different defect. Both had survived every round.

- **A host-independence guard that depended on the host.** `ambient-independence.test.ts` (added
  2026-09-02) re-runs the sqlite suite under a hostile umask, time zone and locale to prove the
  verdict does not depend on the machine. It then reads the nested run's totals line, and the nested
  run inherited `CI` from GitHub Actions, which turns vitest's colour on. The escape codes broke its
  regex: 783 passing, verdict red. This is round 19's defining class, *guards that grade the repo
  and exempt themselves*, back again in a guard written after round 19 named it (`fa8e5e3`).
- **A liveness defect built on a false premise from round 1.** See the case study below (`cdb2e47`).

A third defect surfaced the same way, through the environment rather than review. bridge-telegram's
flood-wait row timed out three times under full-suite load. Root-causing it instead of re-running
found a real off-by-one in net-util's 429 loop: a stated wait equal to the remaining budget was
slept in full, then failed anyway (`acbd645`). The comparison predates round 1 and was in the
shared-package critic's scope in all 18 scored rounds.

### W4. A premise is never re-examined, even when a finding contradicts it

The run fixes instances very well. It has no step that asks *what premise this finding falsifies*,
and the NATS case shows what that costs.

**Case study: one false sentence, three correct fixes, 21 rounds.**

- **Round 1 (`3cc685b`).** The NATS live loop is rebuilt around the stated premise that *"a
  connection drop ends `consume()` with no status event at all"*. So any drop rebuilds from
  `lastSeq + 1`.
- **Round 1 → `dee1631`.** A critic shows the backfill test posts only after the loss, so it grades
  nothing. The fix adds delivery-sequence gap detection and a dead-link test. That test always posts
  a later message, which is what makes the gap visible.
- **Round 4.** A critic finds the first delivery is never gap-checked. Its own finding says the
  first delivery can be lost *"while `consume()` reconnected transparently"*. That sentence
  contradicts the round-1 premise. The fix checks the first delivery; the premise and its comment
  stay.
- **Round 13.** A critic finds the fake's `status()` completes instantly and notes the dead-link
  test *"cannot discriminate"*. Fixed as a fixture-fidelity instance.
- **Rounds 2–21.** The NATS target is reviewed full-surface in 17 more scored rounds. The README
  claims a rebuild on *"any loss (… dropped link)"*. No finding tests it.
- **Post-merge CI, Node 24.** A 60 s hang. nats.js 2.29 does not end `consume()` on a drop: on
  reconnect it re-pulls on the same consumer. A message the server wrote into the dead link
  (`AckPolicy.None`, counted delivered) is recovered only if a *later* message exposes the gap. With
  nothing following, it is never delivered. The deterministic repro was the existing dead-link test
  without its follow-up message.

Every fix in that chain was correct for its instance and proven by mutation. The class that needed
ratcheting was the premise. The evidence against it was written down in round 4, in the finding
itself. truth-in-docs grades documents against the repo's code, not against what a dependency
actually does, so it could not see this either.

### W5. Four lenses file nearly half the findings and none of the blocking ones

Over rounds 1–10, maintainability and test-hygiene filed 101 findings and **zero** blocking ones.
Round 21 widens it. Design-principles, truth-in-docs, test-hygiene and maintainability filed **84 of
188 findings (45%), 0 blocking**. Each is a round's worth of critic attention and fixer triage.
Round 4 showed the alternative: the same concern handed to the *fixer* as an instruction changed
behaviour in one round.

### W6. Batching three months into one merge defeats the release model it ships through

A merge to `main` is a release, and each PR title drives the version bump. The series landed as one
576-commit squash, so 21 rounds of fixes reach users as one `feat:` and one 0.10.0. No human could
review the merge, and it is one revert unit. Bisecting a regression from it means the unsquashed
branch, which exists only until it is deleted. Round 21's own remediation needed an integration pass
to discover cross-package breakage the per-target agents could not see:
- a test double's type, caught only by CI's `typecheck:test` (`fdd52b4`);
- net-util's unconsumed-export list going red once telegram consumed two exports (`857ed65`).

### W7. Isolation defects recur at every new layer of parallelism

Worktrees fixed shared source in round 2. Round 2 then found shared services. Round 20 found a
stateful Synapse room holding 84% of the server's events. Round 21 found two more:
- a critic colliding with a sibling's `/tmp` scratch path;
- **the mutation oracle itself** writing every replay to one fixed log. A concurrent replay could
  pass or fail on a sibling's output (`62debb5`).

An oracle with a concurrency defect is worse than none: it reports with authority. Each layer of
isolation was added after the collision it prevents.

### W8. Cost is metered for review only

The 11 rounds with recorded token counts total **32.1M review tokens**, about 3M a round from
round 15 on. Rounds 1–6 and 13 were not metered consistently. Remediation, which every round
observed to take longer than review, was never metered at all. So the most-quoted cost figure,
~300K tokens per pre-existing blocking defect, is a lower bound by an unknown factor.

---

## What to change, ranked by evidence

1. **Run production CI every round, and land rounds on `main` as they finish.**
   `workflow_dispatch` already exists. W3: two CI runs, two defects that 21 rounds missed. W6: one
   unreviewable merge. Cheapest change on this list with the most direct evidence.
2. **Make a regression pass over the remediation mandatory before a round counts as closed.** W2:
   7 defects in 28 fixes, 0 caught by the suite, all caught by one pass of fresh reviewers.
3. **Treat a flake as a finding.** A test that fails and then passes is root-caused before a re-run
   is accepted. Two of this session's three post-review defects (net-util, NATS) first appeared as
   timing flakes.
4. **Grade a dependency's behaviour by running it.** Wherever a fix rests on what a library, server
   or runtime does, pin that behaviour with a probe against the real dependency, and test the
   behaviour rather than the sentence describing it. That covers `consume()` on reconnect, vitest's
   colour under `CI`, and Node's timer wrap. It is S5's rule applied to everything outside the repo.
5. **Add a "premise falsified" field to the finding schema, and ratchet premises.** W4: the
   contradicting evidence was in round 4's finding, and nothing routed it to the claim it refuted.
6. **Stop on a budget, not on convergence, and move the four null lenses into the fixer's
   instructions.** W1 and W5. Both are already NEXT-EXPERIMENT recommendations; round 21 strengthens
   them rather than changing them.
7. **Keep:** review/remediation separation, mutation proof, the diff guard, the blame oracle,
   critics with real servers, and the self-correcting record (S2–S7). They are what made this
   assessment possible to write from data.

---

## What would change this assessment

- **CI every round still lets the same classes through.** Then W3 is about runtime variance (timing,
  load) rather than environment, and the fix is a stress or chaos schedule, not CI.
- **A second run on a different codebase converges.** Then W1 is a property of this surface and its
  continuous reconstruction, not of the protocol.
- **The null lenses' findings are shown to prevent later blocking ones.** For example, a
  maintainability finding whose fix removes the site of a later defect. Nothing in the data
  measures this. If it exists, W5 overstates the waste.
- **A blind re-review of the merged tree** finds a pre-existing blocking rate well above round 21's
  2. Then the self-induction ceiling was hiding real yield, and W1 overstates how fully the loop had
  turned inward.

## Limits of this reading

- **The same model family wrote this, ran round 21's remediation, and fixed both CI defects.** The
  numbers come from oracles and commit records. The ranking of what matters is judgment, and that
  judgment shares the blind spot the pre-registration warned about.
- **N=1.** One codebase, one partition, three variables moved at once. That confound has not gone
  away.
- **No measure of user impact.** About 239 pre-existing blocking defects were found. How many would
  have reached a user, and how badly, was never labelled.
- **Remediation cost is unmetered** (W8). Every cost-per-defect figure here is a lower bound.
