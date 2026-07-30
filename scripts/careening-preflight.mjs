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
import { connect } from 'node:net';

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

const down = services.filter((s) => !s.up).map((s) => s.name);
const ok = daemon && down.length === 0;

if (json) {
  console.log(JSON.stringify({ ok, daemon, services }, null, 2));
} else if (ok) {
  console.log(`careening preflight OK — daemon up, ${services.length} services answering`);
} else if (!daemon) {
  console.error('careening preflight FAILED — docker daemon is not reachable.');
  console.error('  start it, then: ./examples/dev-compose/dev-infra.sh up all');
} else {
  console.error(`careening preflight FAILED — not answering: ${down.join(', ')}`);
  console.error('  ./examples/dev-compose/dev-infra.sh up all');
}

process.exit(ok ? 0 : 1);
