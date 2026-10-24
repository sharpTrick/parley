#!/usr/bin/env node
import { readFileSync } from 'node:fs';

/**
 * The gate that stops a self-skipping suite from reading as a passing one.
 *
 * A backend whose server failed to come up removes its own coverage and still reports success, so
 * CI asserts the property the run is supposed to provide: every case that did not run is refused,
 * one by one, whatever its siblings did. Judging any coarser unit — a file, a `describe` — lets a
 * case gated on a second account or a seeded fixture vanish beside neighbours that ran.
 *
 * The one skip it admits is a DECLARED capability: a case whose body ran, read the plugin's own
 * context, and found the feature unsupported (the conformance suite's concurrency cases for a
 * backend that declares one writer). That case records which capability it lacks in its task meta
 * before skipping, and the report carries the meta. A `describe.skip`, an `it.skipIf` or a `todo`
 * never reaches a body, so none of them can carry the declaration — the runner reaching the body is
 * what separates "this plugin cannot" from "this server was not there".
 */

/** Ran, in the sense this gate cares about: the runner reached the body. */
const ran = (assertion) => assertion.status === 'passed' || assertion.status === 'failed';

/** A skip the plugin declared from inside the body: `meta.capability` names what it lacks. */
const declared = (assertion) =>
  assertion.status === 'skipped' &&
  typeof assertion.meta?.capability === 'string' &&
  assertion.meta.capability.trim() !== '';

/** `file › describe › title` — enough for the operator to find the server that did not come up. */
const where = (file, assertion) =>
  [file.name, ...(assertion.ancestorTitles ?? []), assertion.title ?? assertion.fullName ?? '(unnamed)']
    .join(' › ');

/**
 * Every case of the run that neither ran nor declared a capability, as reportable lines. Keyed off
 * the report's own shape rather than a list of the gates the repo uses today, so a new way to skip
 * is refused the day it lands.
 *
 * A group that registered ZERO cases has no result to report — `it.each([])` produces no assertion
 * — so the file-level check in {@link main} carries that half, and `derivedRows` carries it within
 * a file that still holds other cases.
 */
function removedCoverage(report) {
  const lines = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (ran(assertion) || declared(assertion)) continue;
      lines.push(`${where(file, assertion)}  [${assertion.status ?? 'no status'}]`);
    }
  }
  return lines;
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
  const silent = files.filter((f) => (f.assertionResults ?? []).length === 0);
  if (silent.length > 0) {
    process.stderr.write(
      'these files registered no case at all — a table derived from the tree came back empty:\n',
    );
    for (const file of silent) process.stderr.write(`  ${file.name}\n`);
    return 1;
  }
  const dead = removedCoverage(report);
  if (dead.length > 0) {
    process.stderr.write(
      'these cases did not run, and none declared a capability its plugin lacks — a server, ' +
        'driver, account or credential they need was unreachable:\n',
    );
    for (const line of dead) process.stderr.write(`  ${line}\n`);
    return 1;
  }
  const cases = files.reduce((n, f) => n + (f.assertionResults ?? []).length, 0);
  const capabilities = files.reduce(
    (n, f) => n + (f.assertionResults ?? []).filter(declared).length,
    0,
  );
  process.stdout.write(
    `ok: ${cases} cases across ${files.length} test files; none skipped away, ` +
      `${capabilities} skipped for a declared capability\n`,
  );
  return 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  process.exit(main(process.argv.slice(2)));
}
