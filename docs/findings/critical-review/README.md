# Critical review — experiments on the review process itself

Findings *about the review mechanism*, not about the code it reviews. This subtree records what we
learn about **how we find things** — the adversarial-review loop as an object of study.

The motivating problem: both humans and agents have blind spots when implementing, and
self-approval bias on top — a working solution is so much better than nothing that it is hard to see
every bug, over-complication or banked debt inside it. Code review is the standard mitigation. But
an *initial* review has blind spots too, seeing `m` issues and leaving `n − m`. The approach under
study: keep reviewing the full surface with fresh contexts, ratcheting fixes into tests each round,
until reviews come back clean — and then ask whether the effort went where the value was.

## Convention

- **Experiments** get a date-prefixed directory with a codename (`2026-07-29-careening/`). The
  `README.md` is the durable record: numbers over adjectives, and always a section stating what
  would change the conclusion. Datasets live in `data/` alongside it.
- **Pre-registration goes in before the run**, not after. The prior art for this subtree is
  ringweave's *ouroboros*, whose headline number turned out to be a post-hoc hand-label applied by
  the same agent that authored the fixes being judged. Deciding what to measure while looking at the
  results is how that happens.
- Date-prefixed because process experiments are *episodes*: which tooling, which protocol version,
  which state the codebase was in are all part of what the record means.

## Experiments

- **[`2026-07-29-careening/`](./2026-07-29-careening/)** — full-surface adversarial review of the
  Parley monorepo, partitioned **by package** (one all-lens critic each) rather than by lens, on a
  deliberately deeper surface than the prior run. Pre-registered; in progress.

## Companion documents

- [`docs/REVIEW_PROTOCOL.md`](../../REVIEW_PROTOCOL.md) — the authoritative process.
- [`.claude/workflows/careening-review.js`](../../../.claude/workflows/careening-review.js) — the
  executable runner.
- [`.claude/agents/critic-package.md`](../../../.claude/agents/critic-package.md) — the reviewer.
- [`skills/critical-review/SKILL.md`](../../../skills/critical-review/SKILL.md) — the operator's guide.

## Prior art

Ringweave's **ouroboros** run (2026-07-24) is the baseline this subtree compares against: 21 rounds,
92 findings, ~5.26M subagent tokens, four lens-specialised critics over one component. Its headline
result was that the loop spent its second half reviewing its own output at roughly 3× the cost per
finding, with one user-visible bug to show for it. Read its corrections section alongside its
conclusions.
