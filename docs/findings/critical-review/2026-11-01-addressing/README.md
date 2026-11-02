# Careening run: agent addressing (2026-11-01)

The adversarial review of the `feat/agent-addressing` change set (whoami, read-before-you-speak,
mention routing, no self-echo), run with the protocol in `docs/REVIEW_PROTOCOL.md` and the runner
`.claude/workflows/careening-review.js`.

## Scope

Every round is full-surface: fifteen critics read every package, not the diff. Round 1 therefore
reported findings in code this change never touched, and they are kept separate:

- **This change's own findings** — anything in a line or file it added or edited, plus anything its
  behaviour caused elsewhere (round 1's four backends whose broadcast or bot-name syntax the new
  mention routing would have read as an address). These are fixed or adjudicated in the branch, in
  the commit that closes the round.
- **Pre-existing findings** — in code the change did not touch and does not affect. They are recorded
  here, unremediated, for a follow-up run; folding them into this change would make it a different
  change. A finding's origin is computed from `git diff -U0` against the change's base, not judged.

## Stopping rule (a departure from the protocol)

The protocol stops after two consecutive wake-all rounds with zero CONFIRMED findings anywhere. With
the pre-existing findings deliberately left for a follow-up, that can never happen here: every round
re-reports some of them. This run is instead capped by the maintainer at **exactly three wake-all
rounds**. Findings in this change — same oracle as above, so a finding this change caused anywhere
still counts — are fixed after each round, including the third; fixes made after round 3 are
mutation-tested but reviewed by no further round, and the PR says so. The follow-up run inherits the
strict rule.

## Data

`data/round<N>-summary.json` is the runner's returned object without its findings;
`data/round<N>-findings.json` is every finding, confirmed and plausible.

| round | base | confirmed (blocking) | plausible | in this change | pre-existing | tokens | wall-clock |
|---|---|---|---|---|---|---|---|
| 1 | `0025502` | 137 (28) | 7 | 26, plus 4 caused elsewhere | 114 | 2.31M | 68 min |
| 2 | `dacb160` | 130 (25) | 7 | 26 | 111 | 2.31M | 73 min |
| 3 | `83feea7` | 139 (23) | 9 | 21 | 127 | 2.58M | 95 min |

Round 3 was the last. Its fixes were mutation-tested but reviewed by no further round. Two
critics in round 3 collided on shared scratch paths in `/tmp` — one with another project's session
(`/tmp/mut.bak`), one with a sibling critic (`/tmp/mut`) — so mutation verdicts from `core-seam`
and `core-auth` near 21:12–21:25 are suspect. Every worktree and the main tree were checked clean
afterwards, and the runner's brief now forbids fixed scratch names in `/tmp`.
