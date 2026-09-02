import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A case whose verdict is decided by the environment rather than by the code is the one defect no
 * amount of reading the source finds: round 15 prescribed provoking a read-only store with
 * `chmod 0444`, which does nothing when the suite runs as root, and round 18 found a control
 * asserting that the RUNNER's umask leaves group/other set — a hardened host turned red for a
 * property no product code depends on, while the matrix it claimed to protect had long since
 * started owning its own umask. Both read as deliberate on the page.
 *
 * So decide it by measurement instead: run this package's suite again with the ambient turned
 * hostile and require the same answer. An assertion that ESTABLISHES what it reads is unmoved; one
 * that inherits it is not. The nested run skips this case, so the cost is one extra pass.
 */
const PROBE = 'PARLEY_AMBIENT_PROBE';
const HOSTILE_UMASK = '0077';
const HOSTILE_ENV = { TZ: 'Pacific/Kiritimati', LC_ALL: 'C', LANG: 'C' };

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

function runHostile(): { status: number; stdout: string; stderr: string } {
  const command = [
    `umask ${HOSTILE_UMASK};`,
    'exec',
    shellQuote(process.execPath),
    shellQuote(join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')),
    'run',
    'packages/bridge-sqlite',
  ].join(' ');
  const run = spawnSync('sh', ['-c', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...HOSTILE_ENV, [PROBE]: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: run.status ?? 1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

/**
 * The nested reporter prints one line per passing case, so a blind tail buries the reason. Keep the
 * failure lines and the totals; fall back to the raw tail when the child died before reporting.
 */
const REPORTED_FAILURE = /^\s*(?:×|FAIL\b|AssertionError\b|→|Test Files\b|Tests\b)/;
function tail(text: string, lines: number): string {
  const all = text.trim().split('\n');
  const failures = all.filter((l) => REPORTED_FAILURE.test(l));
  return (failures.length > 0 ? failures : all).slice(-lines).join('\n');
}

describe.skipIf(process.env[PROBE] === '1')(
  'the suite grades the code, not the host it runs on',
  () => {
    it(
      'answers the same under a hardened umask, a far-future zone and the C locale',
      () => {
        const { status, stdout, stderr } = runHostile();
        const report = stdout.trim() === '' ? stderr : stdout;
        expect(status, tail(report, 40)).toBe(0);
        // A path that matched nothing would satisfy the exit code above while grading nothing.
        const ran = /\bTests\s+(\d+) passed/.exec(stdout);
        expect(ran?.[1], tail(report, 10)).toBeDefined();
        expect(Number(ran?.[1])).toBeGreaterThan(100);
      },
      600_000,
    );
  },
);
