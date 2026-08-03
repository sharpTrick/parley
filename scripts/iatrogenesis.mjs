#!/usr/bin/env node
// Decide, for each finding in a round, whether the line it points at was introduced by this
// experiment or predates it.
//
//   node scripts/iatrogenesis.mjs <round> [--base <sha>] [--start <sha>]
//
// Ouroboros reported "66.7% self-induced" as a hand-label applied by the same agent that authored
// the fixes being judged. This computes the same quantity from `git blame`, which does not share
// that agent's blind spot. That independence is the whole value, so nothing here consults a
// finding's prose.
//
// Blame runs at the round's BASE commit, never at HEAD. The line numbers in a findings record are
// only meaningful against the tree the critic actually read; blaming at HEAD credits later
// remediation commits with earlier findings and reported round 2 at 51% instead of 26%.
//
// Known to over-attribute, in two directions that both inflate the self-induced share: blame
// reports the LAST touch, so a round that merely moved a line is charged with it; and a finding
// anchored on a test rather than on the code it guards is attributed to whoever wrote the test,
// usually the previous round. Treat the number as a ceiling.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DATA = 'docs/findings/critical-review/2026-07-29-careening/data';
const EXPERIMENT_START = '0f35f61';

const args = process.argv.slice(2);
const round = args[0];
if (!round) {
  console.error('usage: iatrogenesis.mjs <round> [--base <sha>] [--start <sha>]');
  process.exit(2);
}
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const start = flag('start', EXPERIMENT_START);

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

const summary = JSON.parse(readFileSync(resolve(DATA, `round${round}-summary.json`), 'utf8'));
const base = flag('base', summary.base);
if (!base) {
  console.error(`round ${round} has no base sha in its summary; pass --base`);
  process.exit(2);
}

const findings = JSON.parse(readFileSync(resolve(DATA, `round${round}-findings.json`), 'utf8'));

const experimentCommits = new Set(
  git('rev-list', `${start}..${base}`)
    .split('\n')
    .filter(Boolean)
    .map((s) => s.slice(0, 40)),
);

let selfInduced = 0;
let preExisting = 0;
let blockingSelf = 0;
let blockingPre = 0;
const unresolvable = [];

const isBlocking = (f) => f.severity === 'blocking' && f.verdict === 'CONFIRMED';

for (const f of findings) {
  if (!f.file || !f.line) {
    unresolvable.push({ file: f.file ?? null, line: f.line ?? null, why: 'no file:line' });
    continue;
  }
  let sha;
  try {
    const out = execFileSync(
      'git',
      ['blame', '-L', `${f.line},${f.line}`, '--porcelain', base, '--', f.file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    sha = out.slice(0, 40);
  } catch {
    // A finding can name a path or a line that does not exist at base — a file the critic proposed,
    // or a line past the end. It is not gradeable either way, so it is reported rather than guessed.
    unresolvable.push({ file: f.file, line: f.line, why: 'no blame at base' });
    continue;
  }
  if (experimentCommits.has(sha)) {
    selfInduced += 1;
    if (isBlocking(f)) blockingSelf += 1;
  } else {
    preExisting += 1;
    if (isBlocking(f)) blockingPre += 1;
  }
}

const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
const graded = selfInduced + preExisting;
const blockingGraded = blockingSelf + blockingPre;
const result = {
  round: Number(round),
  base,
  findings: findings.length,
  graded,
  selfInduced,
  preExisting,
  unresolvable: unresolvable.length,
  selfInducedPct: pct(selfInduced, graded),
  blockingOnly: {
    blocking: blockingGraded,
    selfInduced: blockingSelf,
    preExisting: blockingPre,
    selfInducedPct: pct(blockingSelf, blockingGraded),
  },
};
console.log(JSON.stringify(result, null, 1));
if (unresolvable.length) console.error(JSON.stringify({ unresolvable }, null, 1));
