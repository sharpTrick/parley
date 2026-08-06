#!/usr/bin/env node
// Preflight for one Careening round. The services being up is a PRECONDITION of the round, not
// something to assert once and hope for: the docker daemon died mid-round three times in five
// rounds, and each time the critics reviewed on without them and reported it only in prose, where
// the operator finds it after the round has been paid for.
//
//   node scripts/careening-preflight.mjs           # check, exit 1 if anything is down
//   node scripts/careening-preflight.mjs --json    # machine-readable, same exit code
//
// Exit 0 = every service answered. Exit 1 = at least one did not; the round must not start.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { connect } from 'node:net';

const run = (cmd, argv) => {
  try {
    return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const SERVICES = [
  { name: 'redis', port: 6379 },
  { name: 'nats', port: 4222 },
  { name: 'postgres', port: 5432 },
  { name: 'prosody', port: 5222 },
  { name: 'synapse', port: 8008 },
  { name: 'keycloak', port: 8080 },
];

const reachable = (port) =>
  new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(2_000);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });

function daemonAlive() {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const json = process.argv.includes('--json');
const daemon = daemonAlive();
const services = [];
for (const s of SERVICES) services.push({ ...s, up: daemon ? await reachable(s.port) : false });

// A worktree left at a previous round's base is the most expensive failure this harness can have,
// and the quietest: the runner only tells a critic to `cd` into one, so fifteen critics will review
// a stale tree and return a full round of findings that look exactly like a valid round. Round 17
// spent 3.12M tokens reviewing a commit four rounds old before anyone noticed.
const WORKTREES = '/tmp/careening/worktrees';
// Default to HEAD, so that starting a fresh round on a stale tree is refused. But a round that runs
// in BATCHES must keep every batch on the round's own base — committing this round's findings moves
// HEAD, and rebasing the worktrees mid-round would mean later batches reviewed a different tree than
// earlier ones. `--base <sha>` is how a mid-round check says which tree it means.
const baseFlag = process.argv.indexOf('--base');
const wantRaw = baseFlag === -1 ? 'HEAD' : process.argv[baseFlag + 1];
const head = run('git', ['rev-parse', wantRaw]);
const stale = [];
let worktrees = [];
try {
  worktrees = readdirSync(WORKTREES);
} catch {
  worktrees = [];
}
for (const name of worktrees) {
  const at = run('git', ['-C', `${WORKTREES}/${name}`, 'rev-parse', 'HEAD']);
  if (at !== head) stale.push({ name, at: (at ?? 'unreadable').slice(0, 7) });
}

const down = services.filter((s) => !s.up).map((s) => s.name);
const ok = daemon && down.length === 0 && stale.length === 0;

if (json) {
  console.log(JSON.stringify({ ok, daemon, services, head, stale }, null, 2));
} else if (ok) {
  console.log(
    `careening preflight OK — daemon up, ${services.length} services answering` +
      `, ${worktrees.length} worktrees at ${head.slice(0, 7)}`,
  );
} else if (!daemon) {
  console.error('careening preflight FAILED — docker daemon is not reachable.');
  console.error('  start it, then: ./examples/dev-compose/dev-infra.sh up all');
} else if (down.length) {
  console.error(`careening preflight FAILED — not answering: ${down.join(', ')}`);
  console.error('  ./examples/dev-compose/dev-infra.sh up all');
} else {
  console.error(`careening preflight FAILED — ${stale.length} worktree(s) not at HEAD ${head.slice(0, 7)}:`);
  for (const s of stale) console.error(`  ${s.name} @ ${s.at}`);
  console.error('  node scripts/careening-worktrees.mjs setup $(git rev-parse HEAD)');
}

process.exit(ok ? 0 : 1);
