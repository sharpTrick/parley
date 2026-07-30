# Commit-record corrections

Where a commit's message does not describe everything the commit contains. Recorded here rather
than by rewriting pushed history, since the diffs are correct and only the narration is incomplete.

Both entries have the same cause, and it is worth naming because it is a property of the workflow
rather than an accident: remediation lands as one staged patch per target, several targets share
`packages/bridge-core`, and `git add -A` after applying two patches commits both. The fix is to
extract, apply, and commit **one target at a time**, and to read `git show --stat` before writing
the message rather than after.

## `3d45548` — round 3, core-engine

Also contains the **presence-roster fix**: `computeRoster` was keyed on `Message.senderHandle`,
which the conformance suite makes explicitly optional and which five of ten backends do not carry,
so `parley_list_users` reported one phantom peer on those backends. `PresenceRecord` now carries the
emitting handle (an additive field, per DESIGN §7) and `computeRoster` keys on `emitterOf(rec, m)`,
falling back to `senderHandle` for a pre-`handle` beat.

It was missing from the message because the work came from a mid-run instruction to the agent, and
the message was written from the portion of its report that predated it. Found later by the round-4
zulip agent, which noticed the fix had landed and its own README claim had gone stale in the
opposite direction.

## `f345611` — round 5, core-seam

Also contains **all of bridge-sqlite's round-5 remediation** — 289 → 340 tests. Its own message was
written and then found to have nothing to commit, because the preceding commit had already taken it.
What that commit should have said:

- `connect()` was not exception-safe, and it was two defects: `openDriver` leaked the connection when
  a pragma threw, and `connect()` assigned `this.driver` before five further things that could throw.
  Fifty failed connects against a non-database file left fifty open file descriptors. Every field is
  now assigned only after the work succeeds, including the config fields, so a failed connect no
  longer half-applies configuration. Guarded by a fault generator that makes the nth driver call
  throw, one row per call, with the call count pinned by value so a step added later fails the table
  rather than shipping ungraded.
- The retention window had no arithmetic test. Two independent mutations survived all 149
  prune-related tests: turning the prune SQL into a full scan, and **flipping the cutoff sign** so
  every message is pruned immediately. The sign flip now fails 11.
- The EXPLAIN-plan check ran against a SQL literal restated in the test rather than the statement the
  plugin prepares. Statements now come from one exported map. The critic's own mutation initially
  survived the rewrite, because `substr(ts,1,40) < ?` yields `SCAN messages USING COVERING INDEX`,
  which matched the old assertion; every plan step touching the table must now be a `SEARCH`.
- The test sources were never typechecked — a type error injected into two test files left
  `tsc -b --force` exiting 0. A test-only project now typechecks them, guarded both by running it and
  by comparing every `.ts` in the package against the resolved file list.
- The WAL retry loop retried classes that never heal (NOTADB, READONLY, CORRUPT, FULL), so a corrupt
  store spent the full ladder before failing. Non-lock classes propagate on the first attempt.
- Six duplicate cases deleted, each with its owner named; the unused `in_reply_to` column dropped
  from both read paths, with the select list `satisfies readonly (keyof MessageRow)[]`.

Declined there, with reasoning that generalises: a meta-test tagging each property to exactly one
file was attempted and abandoned, because every non-brittle formulation matched two files and the
rest were textual pins that fail on rewording rather than on regrowth — the "pins what its
neighbour pins" failure the test-hygiene lens exists to catch. The duplication was removed by
deletion instead of policed by a test.

Escalated there: the page cap cannot be expressed across the seam. `catchup.limit: 10001` loads
clean, opens **and prunes** the store, then dies before `bridge up`; the honest fix is a
plugin-declared maximum that core validates against, which needs the frozen `BackendPlugin`.
