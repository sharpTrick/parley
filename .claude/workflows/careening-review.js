// One round of the Careening adversarial review. Protocol: docs/REVIEW_PROTOCOL.md
//
//   Workflow({ scriptPath: "/home/user/parley/.claude/workflows/careening-review.js",
//             args: { round, quiesced, changed, wakeAll } })
//
// Invoke by scriptPath, NOT by name. A named workflow resolves to a snapshot registered when
// the session started, so edits to this file do not reach a `name:` invocation — round 3 ran
// the round-1 script that way (no worktree instruction, no mutation requirement, no args parse).
//
//   round     — round number, for labels and the returned record
//   quiesced  — previous round's `nextQuiesced`, verbatim
//   changed   — `git diff --name-only <last-round-sha>..HEAD`; drives wake-up
//   wakeAll   — run every critic. REQUIRED for any round that may declare convergence.

export const meta = {
  name: 'careening-review',
  description:
    'One Careening round: one all-lens critic per package, full-surface, structured findings, computed convergence.',
  phases: [{ title: 'Review', detail: 'one critic per awake package, in parallel' }],
}

// `dirs` must list EVERY package a target reviews, so that a change in any of them wakes it.
const TARGETS = [
  { key: 'core-seam', dirs: ['bridge-core'], path: 'packages/bridge-core/src — EVERY file directly in src/ plus src/testing/, and their tests. This is defined by exclusion, so that a file added or split out later is reviewed by default: it is all of src/ EXCEPT the auth/, engine/ and transport/ subdirectories, which other targets own.' },
  { key: 'core-engine', dirs: ['bridge-core'], path: 'packages/bridge-core/src/engine and packages/bridge-core/src/transport' },
  { key: 'core-auth', dirs: ['bridge-core'], path: 'packages/bridge-core/src/auth' },
  { key: 'sqlite', dirs: ['bridge-sqlite'], path: 'packages/bridge-sqlite' },
  { key: 'redis', dirs: ['bridge-redis'], path: 'packages/bridge-redis' },
  { key: 'postgres', dirs: ['bridge-postgres'], path: 'packages/bridge-postgres' },
  { key: 'matrix', dirs: ['bridge-matrix'], path: 'packages/bridge-matrix' },
  { key: 'xmpp', dirs: ['bridge-xmpp'], path: 'packages/bridge-xmpp' },
  { key: 'nats', dirs: ['bridge-nats'], path: 'packages/bridge-nats' },
  { key: 'zulip', dirs: ['bridge-zulip'], path: 'packages/bridge-zulip' },
  { key: 'discord', dirs: ['bridge-discord'], path: 'packages/bridge-discord' },
  { key: 'slack', dirs: ['bridge-slack'], path: 'packages/bridge-slack' },
  { key: 'telegram', dirs: ['bridge-telegram'], path: 'packages/bridge-telegram' },
  { key: 'shared', dirs: ['bridge-net-util', 'conformance'], path: 'packages/bridge-net-util and packages/conformance' },
  {
    key: 'repo',
    dirs: [],
    path: 'the repository AS A WHOLE',
    brief: [
      'You own what is true of the REPOSITORY and invisible to every package-scoped critic. Fourteen other critics are reviewing one package each, in parallel, right now. Their job is to find defects INSIDE a package. Yours is not, and duplicating it wastes the round.',
      'OUT OF SCOPE, hand it back: the correctness, concurrency, security or protocol conformance of any single package\'s logic. If you find a bug in one package and it is only in that package, DO NOT report it — its own critic is looking straight at it. The only reason to mention package-local code is as an INSTANCE of a repo-scale pattern, and then the pattern is the finding and the instances are its evidence.',
      'IN SCOPE, and nobody else can see any of it:',
      '(1) CROSS-PACKAGE DUPLICATION. The same logic written N times. Measure it — name every copy and diff them, because the interesting part is usually that the copies have DRIFTED. A known live example to verify and extend rather than rediscover: packages/*/src/cli.ts is ~545 lines across ten packages with ten distinct hashes, differing only by a class name and a REWORDED copy of the same risk comment, and bridge-sqlite alone extracted args.ts and shutdown.ts from it.',
      '(2) COVERAGE ASYMMETRY OF A REPO-WIDE INVARIANT. A guard that ought to hold everywhere but was ratcheted into whichever package happened to find it. Build the matrix — invariant on one axis, package on the other — and report the holes as one finding per invariant, not per cell. This is "ratchet the class, not the instance" at repo scale, and the loop has filed a version of it in four separate rounds without fixing it.',
      '(3) LOCKSTEP DRIFT. Things that must agree and do not: a fix applied to one package and not its nine siblings, package.json fields that should match across workspaces, versions, engines, exports/files/bin wiring, tsconfig and tsconfig.test.json presence, the lockfile against the manifests.',
      '(4) BUILD, CI AND RELEASE PLUMBING. What the workflows CLAIM they verify versus what they run; a suite that can skip itself into a green run; the publish preflight; anything in .github/ or scripts/. Read the workflow files and check the claim against the step.',
      '(5) ROOT-LEVEL TRUTH-IN-DOCS. README.md, DESIGN.md, CLAUDE.md, TASKS.md, CONTRIBUTING.md, CHANGELOG.md — claims about the repo as a whole, checked against the repo as a whole. A package README is its own critic\'s business.',
      '(6) CROSS-PACKAGE COUPLING IN TESTS. A test in package A that asserts on package B\'s source by file path or by regex. It reddens on a behaviour-preserving move in B and reports it as B "rewording" something. Find every one.',
      'Carry the lenses that operate at this scale: design-principles (duplication, DRY, YAGNI), test-integrity, test-hygiene, truth-in-docs, operability-and-release, maintainability, and seam-integrity. Security only where it is repo-scale — committed secrets, workflow token scope, publish configuration. Tag each finding with the lens that produced it.',
      'Prefer MEASUREMENT to impression throughout. You are the only critic with the whole tree in view, so counts, hashes, matrices and diffs are your instrument: "this helper is byte-identical in six files, here they are" beats "there is some duplication". A finding of yours should be one nobody could have reached by reading a single package.',
    ].join(' '),
  },
]

const HTTP_BACKENDS = ['matrix', 'zulip', 'discord', 'slack', 'telegram']
const BACKENDS = [
  'sqlite', 'redis', 'postgres', 'matrix', 'xmpp', 'nats', 'zulip', 'discord', 'slack', 'telegram',
]

function wakeSet(changedPaths) {
  const woken = new Set()
  const touched = (frag) => changedPaths.some((p) => p.includes(frag))

  for (const t of TARGETS) {
    if (t.dirs.some((d) => changedPaths.some((p) => p.startsWith(`packages/${d}/`)))) woken.add(t.key)
  }
  // The repo critic owns cross-package invariants, so ANY change can break one — including a change
  // to a file no package-scoped target claims (a workflow, a root doc, the lockfile).
  if (changedPaths.length > 0) woken.add('repo')
  if (touched('packages/bridge-core/')) for (const t of TARGETS) woken.add(t.key)
  if (touched('packages/bridge-net-util/')) for (const k of HTTP_BACKENDS) woken.add(k)
  if (touched('packages/conformance/')) for (const k of BACKENDS) woken.add(k)
  if (['CLAUDE.md', 'DESIGN.md', 'docs/REVIEW_PROTOCOL.md', 'vitest.config.ts', 'tsconfig.base.json']
    .some((f) => changedPaths.includes(f))) {
    for (const t of TARGETS) woken.add(t.key)
  }
  return woken
}

// --- finding schema ----------------------------------------------------------------------------
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    nothingFound: {
      type: 'boolean',
      description: 'true iff a genuine attempt to break it found nothing (name what you checked)',
    },
    checked: { type: 'string', description: 'what you examined and tried, so a clean result is auditable' },
    coverage: {
      type: 'object',
      additionalProperties: false,
      properties: {
        passes: { type: 'number', description: 'times you ran stage 3 (1 if you never looped back)' },
        foundOnLaterPass: { type: 'string', description: 'what a later pass found that the first missed, or "nothing"' },
        inventoryCount: { type: 'number', description: 'items stage 1 enumerated' },
        unexaminedItems: { type: 'string', description: 'inventoried items never examined, by name, or "none"' },
        lensesWithoutAttempt: { type: 'string', description: 'lenses that returned nothing and cannot name what was tried, or "none"' },
        untestedReliances: { type: 'string', description: 'tests relied on but never mutated, by name, or "none"' },
      },
      required: ['passes', 'foundOnLaterPass', 'inventoryCount', 'unexaminedItems', 'lensesWithoutAttempt', 'untestedReliances'],
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { enum: ['blocking', 'suggestion'] },
          verdict: { enum: ['CONFIRMED', 'PLAUSIBLE'] },
          lens: {
            enum: [
              'correctness', 'concurrency-and-failure', 'security', 'seam-integrity',
              'design-principles', 'protocol-conformance', 'test-integrity', 'truth-in-docs',
              'operability-and-release', 'maintainability', 'test-hygiene',
            ],
            description: 'which lens produced this — a measurement, so be accurate not generous',
          },
          theme: { type: 'string', description: 'coarse kebab slug ABOVE class; ratchet the theme' },
          class: { type: 'string', description: 'kebab slug of the finding TYPE' },
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          failure: { type: 'string', description: 'concrete input -> wrong output / hang' },
          remediation: { type: 'string' },
          // Round 13: all 33 blocking findings were real, and EIGHT of the remediations were wrong —
          // several would have shipped a defect. These fields are the specific checks that would
          // have caught each one. Answer them about YOUR OWN fix, from the code, not from intent.
          remediationCheck: {
            type: 'object',
            additionalProperties: false,
            properties: {
              reliesOn: { type: 'string', description: 'existing code your fix calls, and the branch you depend on; quote it, or "nothing"' },
              newlyAccepts: { type: 'string', description: 'one input your fix accepts that today rejects, or "none"' },
              newlyRejects: { type: 'string', description: 'one input your fix rejects that today accepts, or "none"' },
              testsThatWouldFail: { type: 'string', description: 'passing tests your fix breaks, by name, or "none found — and here is where I looked"' },
              hidesOrFixes: { type: 'string', description: 'what stays broken if applied while the bug remains; "nothing" means it hides the symptom' },
              interleavings: { type: 'string', description: 'concurrency fixes only: the orderings, incl. two callers on your new path; else "n/a"' },
              confidence: { enum: ['traced', 'plausible', 'untested'] },
            },
            required: ['reliesOn', 'newlyAccepts', 'newlyRejects', 'testsThatWouldFail', 'hidesOrFixes', 'interleavings', 'confidence'],
          },
          testUpgrade: { type: 'string', description: 'parameterized/fuzz test guarding the CLASS' },
        },
        required: ['severity', 'verdict', 'lens', 'theme', 'class', 'file', 'summary', 'failure', 'remediation'],
      },
    },
  },
  required: ['nothingFound', 'findings'],
}

const WORKTREES = '/tmp/careening/worktrees'

// The runner cannot create or inspect worktrees — a workflow script has no filesystem access — so it
// can only tell a critic which one to use. That makes a worktree left at a PREVIOUS round's base the
// quietest failure this harness has: fifteen critics review a stale tree and return a full round of
// findings indistinguishable from a valid one. Round 17 spent 3.12M tokens on a commit four rounds
// old. `scripts/careening-preflight.mjs` now refuses to pass when any worktree is off HEAD; this is
// the second half of that guard, so a critic that somehow starts anyway errors LOUDLY instead of
// reviewing the wrong code.
const baseCheck = (key, base) =>
  base
    ? `FIRST, before reading anything: run \`git -C ${WORKTREES}/${key} rev-parse HEAD\`. It MUST print ${base}. If it prints anything else your worktree is stale and every finding you could produce would be against the wrong tree — STOP, review nothing, and return errored=true with the sha you actually saw. Do not try to fix it yourself.`
    : ''

function prompt(target) {
  if (target.brief) {
    return [
      baseCheck(target.key, base),
      `Work ONLY inside your own git worktree: ${WORKTREES}/${target.key} — cd there first. It is pinned to this round's base commit and is yours alone, so you may freely edit, mutate and break things; nobody merges from it and it is deleted after the round. Do NOT read or write /home/user/parley.`,
      target.brief,
      `Review the tree AS IT STANDS NOW — NOT a diff, and NOT "only what changed since the last round."`,
      `Read CLAUDE.md and DESIGN.md first for the invariants.`,
      `VERIFY each issue against the tree before reporting — run the count, take the hashes, read both sides of the claimed drift. Mark CONFIRMED only when traced or reproduced; otherwise PLAUSIBLE.`,
      `The suite's GREEN STATE IS GIVEN: it was verified before this round. Do NOT re-run it to confirm it passes. Run or mutate tests only as an instrument — to prove a guard is vacuous, or that an invariant genuinely is unguarded in the packages your matrix says are uncovered.`,
      `Do NOT start containers. Nothing at this scale needs one, and the shared parley-dev-* set belongs to the orchestrator while other critics are using it.`,
      `Return the structured schema. For each finding give the concrete failure — what breaks, or what silently is not checked, and where — a remediation, and a testUpgrade that guards the CLASS across the whole repo rather than patching the instances one at a time.`,
      `If a genuine attempt found nothing at repo scale, set nothingFound=true and describe specifically which invariants you built a matrix for and what you diffed — a clean result retires you from later rounds, so it must be auditable.`,
    ].filter(Boolean).join(' ')
  }
  return [
    baseCheck(target.key, base),
    `Work ONLY inside your own git worktree: ${WORKTREES}/${target.key} — cd there first. It is pinned to this round's base commit and is yours alone, so you may freely edit, mutate and break things; nobody merges from it and it is deleted after the round. Do NOT read or write /home/user/parley.`,
    `Full-surface adversarial review of the Parley package at: ${target.path}.`,
    `Review the WHOLE target AS IT STANDS NOW — NOT a diff, and NOT "only what changed since the last round." A diff-scoped review hides everything the current anchors sit on top of.`,
    `Carry ALL ELEVEN lenses yourself (docs/REVIEW_PROTOCOL.md): correctness, concurrency-and-failure, security, seam-integrity, design-principles, protocol-conformance, test-integrity, truth-in-docs, operability-and-release, maintainability, test-hygiene. Tag every finding with the lens that produced it — that tag is a measurement.`,
    `Read CLAUDE.md and DESIGN.md first for the invariants, especially the prime directive: bridge-core must never import from a backend plugin.`,
    `Try hard to BREAK it. VERIFY each issue against the code — trace it or reproduce it — before reporting. Mark CONFIRMED only when traced or reproduced; otherwise PLAUSIBLE.`,
    `The suite's GREEN STATE IS GIVEN: it was verified before this round. Do NOT re-run it to confirm it passes. Run tests only as an instrument — to reproduce a defect, or to MUTATE code and prove a test is vacuous. Mutation-testing is EXPECTED for the test-integrity and test-hygiene lenses: for any test you rely on, ask what mutation would keep it green, make it, and watch. A test that cannot fail is worse than none, because it counts as coverage.`,
    `You may start throwaway containers ONLY for the backend you own, with a distinct name and port, and you must tear them down. Never touch a container you did not create — the shared parley-dev-* set belongs to the orchestrator and other agents are using it. Copy the image and flags from examples/dev-compose/docker-compose.yml.`,
    `Several lenses are mechanically checkable; CHECK them rather than reasoning about them: seam integrity via the import graph and \`git diff --stat packages/bridge-core\`, protocol conformance against packages/conformance, truth-in-docs by reading each claim and then the code behind it.`,
    `WORK IN STAGES, AND LOOP BACK WHEN A STAGE NAMES A GAP. Do not free-associate over the target; a reviewer that anchors on the first big thing it sees leaves the rest of the surface unexamined. Measured across rounds 1-5, findings against the long files clustered 75/104/66/25 by quartile — the last quarter of a file drew 9% of findings against 25% expected, and those tails held the richest concurrency surfaces, not trivia. The stages exist to make that decay visible instead of invisible.`,
    `STAGE 1 - INVENTORY. Enumerate the surface before judging any of it: every source file, its exported symbols, its entry points, and which test files grade each one. Produce a LIST with counts. You may not skip this because the target looks familiar — the list is what later stages are audited against.`,
    `STAGE 2 - CLAIMS. For each item, what does it claim about itself — JSDoc, README lines, test names, comment invariants? Note each claim and where it is stated. A claim is a thing that can be false; this is the raw material for truth-in-docs and for finding code that no longer does what its own doc says.`,
    `STAGE 3 - ATTACK. Now try to break it, lens by lens. For EVERY lens, you owe either a finding or a specific sentence naming what you tried and why it held. "Nothing found" without a named attempt is not an answer for a lens; it is a lens you did not run.`,
    `STAGE 4 - VERIFY. Reproduce or trace every candidate against the code. CONFIRMED only when traced or reproduced, otherwise PLAUSIBLE. A candidate you cannot verify either way is PLAUSIBLE with the reason, never quietly dropped.`,
    `STAGE 5 - MUTATE. For every test you are relying on to say something is safe, ask what edit would keep it green, make that edit, and watch. This is where the round-13 haul came from: a mocked suite deciding a storage property it cannot see, a ReDoS screen never exercised at its boundary, a registry deriving its subject from the thing it audits. Verify the mutation ACTUALLY APPLIED before trusting a red or a green — a mutation that silently failed to match makes an unmutated suite look like proof, which has happened to this project's operator twice.`,
    `STAGE 6 - SELF-AUDIT, then decide whether you are done. Check your own work against stage 1's list and answer three questions concretely: which inventoried items produced no finding AND were never actually examined; which lenses returned nothing without a named attempt from stage 3; which relied-upon tests never had a mutation run in stage 5. Each answer is a NAMED GAP.`,
    `IF STAGE 6 NAMES ANY GAP, GO BACK TO STAGE 3 FOR THOSE ITEMS ONLY, then re-run stage 6. Repeat until the gap list is empty or you can say in one sentence per remaining gap why closing it is not possible from here. The trigger is a named gap, never a feeling of incompleteness — do not loop because you are uneasy, and do not stop because you are satisfied. Report the number of passes you made and what the earlier passes missed, because a second pass that found something is the most useful signal you can give about whether this stage structure is worth its cost.`,
    `Return the structured schema. For each finding give the concrete failing input -> wrong output or hang, a remediation, and a testUpgrade that guards the CLASS (a parameterized or widened generator case), not just the one input.`,
    `FILL IN remediationCheck HONESTLY — it is the highest-value thing you produce after the finding itself. In round 13 every one of 33 blocking findings was real and EIGHT of the remediations were wrong, several of which would have shipped a defect worse than the one they closed. Your finding is probably right; your fix is the part that is probably wrong. Do NOT write a persuasive argument for your fix, and do NOT write a rhetorical passage attacking it either — both are cheap to fake and neither is checkable. Answer the specific questions from the CODE: read what you call into, name what your fix newly accepts and newly rejects, name the passing tests it breaks, and say what would still be broken if it were applied and the bug remained. If you did not trace it, mark it untested — a separate agent re-derives every fix from scratch, so an honest "untested" costs nothing and a confident wrong answer costs that agent a wasted investigation.`,
    `If a genuine attempt to break it found nothing, set nothingFound=true and describe specifically what you examined and what you tried — a clean result retires you from later rounds until your package or a dependency changes, so it must be auditable.`,
  ].filter(Boolean).join(' ')
}

// --- run ---------------------------------------------------------------------------------------
// `args` arrives as a JSON STRING when the caller passes an object literal, which silently
// defaulted round to 1 and wakeAll to false in round 2 — and wakeAll false makes a round
// convergence-INELIGIBLE, so a clean round could never have stopped the loop. Parse both shapes.
const rawArgs = typeof args === 'string' ? JSON.parse(args) : args
const round = (rawArgs && rawArgs.round) || 1
const quiesced = new Set((rawArgs && rawArgs.quiesced) || [])
const changed = (rawArgs && rawArgs.changed) || []
const wakeAll = !!(rawArgs && rawArgs.wakeAll)
const base = (rawArgs && rawArgs.base) || ''

const woken = wakeAll ? new Set(TARGETS.map((t) => t.key)) : wakeSet(changed)
const active = TARGETS.filter((t) => wakeAll || !quiesced.has(t.key) || woken.has(t.key))
const asleep = TARGETS.filter((t) => !active.includes(t))

log(
  `Round ${round}: ${active.length}/${TARGETS.length} critics running` +
    (asleep.length ? ` · ${asleep.length} quiesced (${asleep.map((t) => t.key).join(', ')})` : '') +
    (wakeAll ? ' · WAKE-ALL (convergence-eligible)' : ' · not convergence-eligible'),
)

phase('Review')
const results = await parallel(
  active.map((t) => () =>
    agent(prompt(t), {
      label: `critic:${t.key}`,
      phase: 'Review',
      agentType: 'critic-package',
      schema: SCHEMA,
    })
      // agent() answers NULL when a subagent dies on a terminal error — it does not reject, so the
      // .catch below never sees it. Keep this branch, so that a critic which never ran can never be
      // read as a critic that ran and found nothing: round 15 had all fifteen blocked before they
      // started and the round declared CONVERGENCE on zero evidence, then quiesced every target.
      .then((r) =>
        r === null || r === undefined
          ? { target: t.key, dirs: t.dirs, nothingFound: false, checked: '', findings: [], errored: true }
          : {
              target: t.key,
              dirs: t.dirs,
              nothingFound: !!r.nothingFound,
              checked: r.checked || '',
              findings: r.findings || [],
            },
      )
      .catch(() => ({ target: t.key, dirs: t.dirs, nothingFound: false, checked: '', findings: [], errored: true })),
  ),
)

const all = results.flatMap((r) => r.findings.map((f) => ({ target: r.target, dirs: r.dirs, ...f })))
const confirmed = all.filter((f) => f.verdict === 'CONFIRMED')
const blocking = confirmed.filter((f) => f.severity === 'blocking')
const plausible = all.filter((f) => f.verdict === 'PLAUSIBLE')
const errored = results.filter((r) => r.errored).map((r) => r.target)

if (errored.length) log(`WARNING: critics errored (not a clean round): ${errored.join(', ')}`)

// Require wakeAll, so that convergence is never declared while a quiesced package is a missing lens.
const converged = confirmed.length === 0 && errored.length === 0 && wakeAll

// Shadow signal: recorded, never acted on.
const blockingClean = blocking.length === 0 && errored.length === 0 && wakeAll

// `nextQuiesced` is the FULL set for the next round — pass it back verbatim, so that already-asleep
// targets are not silently re-woken.
const ranClean = results
  .filter((r) => !r.errored && r.findings.every((f) => f.verdict !== 'CONFIRMED'))
  .map((r) => r.target)
const nextQuiesced = [...new Set([...ranClean, ...asleep.map((t) => t.key)])]

const byLens = {}
for (const f of all) {
  byLens[f.lens] = byLens[f.lens] || { total: 0, confirmed: 0, blocking: 0 }
  byLens[f.lens].total++
  if (f.verdict === 'CONFIRMED') byLens[f.lens].confirmed++
  if (f.verdict === 'CONFIRMED' && f.severity === 'blocking') byLens[f.lens].blocking++
}

log(
  `Round ${round}: ${confirmed.length} confirmed (${blocking.length} blocking), ${plausible.length} plausible` +
    ` · converged=${converged} · blockingClean=${blockingClean}`,
)

return {
  round,
  converged,
  blockingClean,
  wakeAll,
  counts: {
    confirmed: confirmed.length,
    blocking: blocking.length,
    plausible: plausible.length,
    total: all.length,
  },
  ranTargets: active.map((t) => t.key),
  quiescedTargets: asleep.map((t) => t.key),
  nextQuiesced,
  byTarget: results.map((r) => ({
    target: r.target,
    nothingFound: r.nothingFound,
    findings: r.findings.length,
    errored: !!r.errored,
    checked: r.checked,
  })),
  byLens,
  confirmed,
  plausible,
}
