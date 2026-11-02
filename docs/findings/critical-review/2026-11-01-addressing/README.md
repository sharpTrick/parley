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

## Data

`data/round<N>-summary.json` is the runner's returned object without its findings;
`data/round<N>-findings.json` is every finding, confirmed and plausible.

| round | base | confirmed (blocking) | plausible | in this change | pre-existing | tokens | wall-clock |
|---|---|---|---|---|---|---|---|
| 1 | `0025502` | 137 (28) | 7 | 26, plus 4 caused elsewhere | 114 | 2.31M | 68 min |
