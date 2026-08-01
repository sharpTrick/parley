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
              reliesOn: {
                type: 'string',
                description:
                  'Existing code your fix calls into, and the SPECIFIC branch or constant you depend on — quote it. Say "nothing" if it stands alone. (A round-13 remediation told bridge-redis to call plaintextRemoteOrigin, whose SECURE_SCHEMES lacks rediss:, so it would have warned on every correctly-configured TLS deployment.)',
              },
              newlyAccepts: {
                type: 'string',
                description:
                  'One concrete input your fix ACCEPTS that today\'s code rejects, or "none". (A round-13 remediation proposed building an HTTP-date with Date.UTC; V8 returns NaN for "Nov 32" where Date.UTC rolls it into a plausible instant — the fix LOOSENED the parser.)',
              },
              newlyRejects: {
                type: 'string',
                description:
                  'One concrete input your fix REJECTS that today\'s code accepts, or "none". Name who legitimately sends it.',
              },
              testsThatWouldFail: {
                type: 'string',
                description:
                  'Currently-passing tests your fix breaks, BY NAME, or "none found — and I looked, here is where". (A round-13 remediation\'s tie-break broke an existing test driving 200 client ids.)',
              },
              hidesOrFixes: {
                type: 'string',
                description:
                  'If your fix were applied and the underlying defect REMAINED, what would still be visibly broken? If the honest answer is "nothing", you are proposing to hide the symptom. (A round-13 remediation proposed pinning TZ, which turns "red for every non-UTC user" into "green for everyone including the broken".)',
              },
              interleavings: {
                type: 'string',
                description:
                  'CONCURRENCY FIXES ONLY, else "n/a". Walk the orderings, including two callers both taking your new path. (A round-13 remediation for a lock TOCTOU was itself a TOCTOU: A unlinks, claims, re-reads, then B unlinks A\'s fresh claim, and both proceed.)',
              },
              confidence: {
                enum: ['traced', 'plausible', 'untested'],
                description:
                  'traced = you followed your fix through the real code or ran it. untested = you have not. Be accurate rather than generous; "untested" is useful data and costs you nothing, while a wrong "traced" is what the remediating agent will trust.',
              },
            },
            required: [
              'reliesOn',
              'newlyAccepts',
              'newlyRejects',
              'testsThatWouldFail',
              'hidesOrFixes',
              'interleavings',
              'confidence',
            ],
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

function prompt(target) {
  if (target.brief) {
    return [
      `Work ONLY inside your own git worktree: ${WORKTREES}/${target.key} — cd there first. It is pinned to this round's base commit and is yours alone, so you may freely edit, mutate and break things; nobody merges from it and it is deleted after the round. Do NOT read or write /home/user/parley.`,
      target.brief,
      `Review the tree AS IT STANDS NOW — NOT a diff, and NOT "only what changed since the last round."`,
      `Read CLAUDE.md and DESIGN.md first for the invariants.`,
      `VERIFY each issue against the tree before reporting — run the count, take the hashes, read both sides of the claimed drift. Mark CONFIRMED only when traced or reproduced; otherwise PLAUSIBLE.`,
      `The suite's GREEN STATE IS GIVEN: it was verified before this round. Do NOT re-run it to confirm it passes. Run or mutate tests only as an instrument — to prove a guard is vacuous, or that an invariant genuinely is unguarded in the packages your matrix says are uncovered.`,
      `Do NOT start containers. Nothing at this scale needs one, and the shared parley-dev-* set belongs to the orchestrator while other critics are using it.`,
      `Return the structured schema. For each finding give the concrete failure — what breaks, or what silently is not checked, and where — a remediation, and a testUpgrade that guards the CLASS across the whole repo rather than patching the instances one at a time.`,
      `If a genuine attempt found nothing at repo scale, set nothingFound=true and describe specifically which invariants you built a matrix for and what you diffed — a clean result retires you from later rounds, so it must be auditable.`,
    ].join(' ')
  }
  return [
    `Work ONLY inside your own git worktree: ${WORKTREES}/${target.key} — cd there first. It is pinned to this round's base commit and is yours alone, so you may freely edit, mutate and break things; nobody merges from it and it is deleted after the round. Do NOT read or write /home/user/parley.`,
    `Full-surface adversarial review of the Parley package at: ${target.path}.`,
    `Review the WHOLE target AS IT STANDS NOW — NOT a diff, and NOT "only what changed since the last round." A diff-scoped review hides everything the current anchors sit on top of.`,
    `Carry ALL ELEVEN lenses yourself (docs/REVIEW_PROTOCOL.md): correctness, concurrency-and-failure, security, seam-integrity, design-principles, protocol-conformance, test-integrity, truth-in-docs, operability-and-release, maintainability, test-hygiene. Tag every finding with the lens that produced it — that tag is a measurement.`,
    `Read CLAUDE.md and DESIGN.md first for the invariants, especially the prime directive: bridge-core must never import from a backend plugin.`,
    `Try hard to BREAK it. VERIFY each issue against the code — trace it or reproduce it — before reporting. Mark CONFIRMED only when traced or reproduced; otherwise PLAUSIBLE.`,
    `The suite's GREEN STATE IS GIVEN: it was verified before this round. Do NOT re-run it to confirm it passes. Run tests only as an instrument — to reproduce a defect, or to MUTATE code and prove a test is vacuous. Mutation-testing is EXPECTED for the test-integrity and test-hygiene lenses: for any test you rely on, ask what mutation would keep it green, make it, and watch. A test that cannot fail is worse than none, because it counts as coverage.`,
    `You may start throwaway containers ONLY for the backend you own, with a distinct name and port, and you must tear them down. Never touch a container you did not create — the shared parley-dev-* set belongs to the orchestrator and other agents are using it. Copy the image and flags from examples/dev-compose/docker-compose.yml.`,
    `Several lenses are mechanically checkable; CHECK them rather than reasoning about them: seam integrity via the import graph and \`git diff --stat packages/bridge-core\`, protocol conformance against packages/conformance, truth-in-docs by reading each claim and then the code behind it.`,
    `Return the structured schema. For each finding give the concrete failing input -> wrong output or hang, a remediation, and a testUpgrade that guards the CLASS (a parameterized or widened generator case), not just the one input.`,
    `FILL IN remediationCheck HONESTLY — it is the highest-value thing you produce after the finding itself. In round 13 every one of 33 blocking findings was real and EIGHT of the remediations were wrong, several of which would have shipped a defect worse than the one they closed. Your finding is probably right; your fix is the part that is probably wrong. Do NOT write a persuasive argument for your fix, and do NOT write a rhetorical passage attacking it either — both are cheap to fake and neither is checkable. Answer the specific questions from the CODE: read what you call into, name what your fix newly accepts and newly rejects, name the passing tests it breaks, and say what would still be broken if it were applied and the bug remained. If you did not trace it, mark it untested — a separate agent re-derives every fix from scratch, so an honest "untested" costs nothing and a confident wrong answer costs that agent a wasted investigation.`,
    `If a genuine attempt to break it found nothing, set nothingFound=true and describe specifically what you examined and what you tried — a clean result retires you from later rounds until your package or a dependency changes, so it must be auditable.`,
  ].join(' ')
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
      .then((r) => ({
        target: t.key,
        dirs: t.dirs,
        nothingFound: !!(r && r.nothingFound),
        checked: (r && r.checked) || '',
        findings: (r && r.findings) || [],
      }))
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
