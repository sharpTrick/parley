import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { CLAUSES } from '@sharptrick/parley-conformance';
import { BROKEN_VARIANTS } from './reference-plugin.js';

/**
 * The suite's negative control. A suite that accepts every plugin certifies nothing, and an
 * assertion nobody can see fail is indistinguishable from a deleted one — so each deliberately
 * broken plugin must FAIL the case built to catch it. Vitest cannot invert a whole suite's result
 * in-process, hence the child run: the broken suites are registered only under
 * `PARLEY_CONFORMANCE_BROKEN`, and this test grades the child's JSON report.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TARGET = 'packages/conformance/test/broken-variants.test.ts';

interface JsonReport {
  testResults: { assertionResults: { fullName: string; status: string }[] }[];
}

let report: JsonReport;
let stdout = '';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-negative-control-'));
  const out = join(dir, 'report.json');
  try {
    const run = await promisify(execFile)(
      'npx',
      ['vitest', 'run', TARGET, '--reporter=json', `--outputFile=${out}`, '--testTimeout=20000'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PARLEY_CONFORMANCE_BROKEN: '1', CI: '1' },
        maxBuffer: 64 * 1024 * 1024,
      },
    ).catch((err: { stdout?: string; stderr?: string }) => err);
    stdout = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    report = JSON.parse(readFileSync(out, 'utf8')) as JsonReport;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);

const results = (): { fullName: string; status: string }[] =>
  report.testResults.flatMap((f) => f.assertionResults);

/**
 * The one-to-one-ness, made mechanical. A clause with no variant is a clause whose assertions can be
 * gutted with this whole package — negative control included — staying green; seven of them were in
 * exactly that state, the lost-wakeup race among them. Nothing in the clause registry or the
 * suite-shape checks can see it, because both grade only that a case with the right title exists.
 */
describe('every clause the suite grades has a plugin that fails it', () => {
  it.each(CLAUSES.map((c) => [c]))('%s', (clause) => {
    const controls = BROKEN_VARIANTS.filter(
      (v) => clause.includes(v.mustFail) || v.mustFail.includes(clause),
    );
    expect(
      controls.map((v) => v.name),
      `no BROKEN_VARIANTS entry names "${clause}" — add the plugin mutation that proves the ` +
        `clause's assertions can fail`,
    ).not.toEqual([]);
  });

  it('has no variant aimed at a clause the suite no longer grades', () => {
    const orphans = BROKEN_VARIANTS.filter(
      (v) => !CLAUSES.some((c) => c.includes(v.mustFail) || v.mustFail.includes(c)),
    );
    expect(orphans.map((v) => v.name)).toEqual([]);
  });
});

describe('the suite rejects a non-conformant plugin', () => {
  // Without this the per-variant rows below read an empty report and pass having graded nothing.
  it('the child run collected every broken variant', () => {
    expect(report, stdout.slice(-4_000)).toBeDefined();
    expect(results().length).toBeGreaterThan(BROKEN_VARIANTS.length);
    for (const variant of BROKEN_VARIANTS) {
      expect(results().some((r) => r.fullName.includes(`broken/${variant.name}`))).toBe(true);
    }
  });

  it.each(BROKEN_VARIANTS.map((v) => [v.name, v.mustFail] as const))(
    'fails a plugin with %s',
    (name, mustFail) => {
      const mine = results().filter((r) => r.fullName.includes(`broken/${name}`));
      const failed = mine.filter((r) => r.status === 'failed');
      expect(failed.length, `no case failed for "${name}"`).toBeGreaterThan(0);
      expect(
        failed.map((r) => r.fullName).join('\n'),
        `"${name}" failed, but not the case it is built to break`,
      ).toContain(mustFail);
    },
  );
});
