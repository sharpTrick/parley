#!/usr/bin/env node
import { readFileSync } from 'node:fs';

/**
 * The gate that stops a self-skipping suite from reading as a passing one.
 *
 * A backend whose server failed to come up removes its own coverage and still reports success, so
 * CI asserts the property the run is supposed to provide. The rule this replaces failed only a test
 * FILE whose every assertion skipped, and 14 files across 7 packages mix a server-gated block with
 * ungated ones — the gated half vanished and the file still reported passes. Judge each GROUP a
 * `describe` forms, so that whether missing coverage is visible stops depending on what else the
 * file happens to hold.
 *
 * A single case skipping among running siblings is a capability the plugin DECLARED (the
 * conformance suite skips the concurrency cases for a backend whose context says one writer), which
 * is a statement in the repo rather than an absent dependency. A whole group vanishing is not.
 */

/** Ran, in the sense this gate cares about: the runner reached the body. Anything else is removed. */
const ran = (assertion) => assertion.status === 'passed' || assertion.status === 'failed';

/** `file › describe › describe` for an assertion — the group whose disappearance is the signal. */
const groupOf = (file, assertion) => [file.name, ...(assertion.ancestorTitles ?? [])].join(' › ');

/**
 * Every group of the run in which NOTHING ran, as reportable lines. Keyed off the report's own
 * shape rather than a list of the gates the repo uses today, so a new way to skip is graded the day
 * it lands.
 */
function removedCoverage(report) {
  const groups = new Map();
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      const key = groupOf(file, assertion);
      const seen = groups.get(key) ?? { ran: 0, skipped: [] };
      if (ran(assertion)) seen.ran += 1;
      else seen.skipped.push(assertion.title ?? assertion.fullName ?? '(unnamed)');
      groups.set(key, seen);
    }
  }
  return [...groups]
    .filter(([, seen]) => seen.ran === 0 && seen.skipped.length > 0)
    .map(([key, seen]) => `${key}\n      ${seen.skipped.join('\n      ')}`);
}

function main(argv) {
  const [path] = argv;
  if (path === undefined) {
    process.stderr.write('usage: assert-no-skipped-tests.mjs <vitest-json-report>\n');
    return 2;
  }
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const files = report.testResults ?? [];
  if (files.length === 0) {
    process.stderr.write(`${path} reports no test files at all — the suite did not run\n`);
    return 1;
  }
  const dead = removedCoverage(report);
  if (dead.length > 0) {
    process.stderr.write(
      'these groups ran nothing — their server, driver or credential was unreachable:\n',
    );
    for (const group of dead) process.stderr.write(`  ${group}\n`);
    return 1;
  }
  const cases = files.reduce((n, f) => n + (f.assertionResults ?? []).length, 0);
  process.stdout.write(`ok: ${cases} cases across ${files.length} test files, none skipped away\n`);
  return 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  process.exit(main(process.argv.slice(2)));
}
