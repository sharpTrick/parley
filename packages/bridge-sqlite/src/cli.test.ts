import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs, SQLITE_VERSION, USAGE } from './args.js';
import { MAX_PAGE } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const repoRoot = join(pkgDir, '..', '..');
// The built CLI (dist/cli.js) — the real orphaning drive runs the compiled entrypoint as a child.
const CLI = join(pkgDir, 'dist', 'cli.js');

/** Newest mtime among the sources tsc actually emits — test files are excluded from the build. */
function newestSourceMtime(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((newest, e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return Math.max(newest, newestSourceMtime(p));
    if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) return newest;
    return Math.max(newest, statSync(p).mtimeMs);
  }, 0);
}

/**
 * A test that executes `dist/` grades whatever the last build left behind, so build it here
 * rather than assuming a prior `npm run build` — an edit to `src/cli.ts` must not pass against a
 * stale artifact, and a missing one must not surface as an opaque spawn error.
 */
beforeAll(() => {
  const stale = (): boolean => {
    try {
      return statSync(CLI).mtimeMs < newestSourceMtime(join(pkgDir, 'src'));
    } catch {
      return true;
    }
  };
  if (!stale()) return;
  // --force, so that a deleted dist rebuilds: tsbuildinfo sits outside dist and otherwise reports
  // the project up to date while the artifact this test executes is gone.
  execFileSync('npx', ['tsc', '-b', 'packages/bridge-sqlite', '--force'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  expect(stale(), `run \`npm run build\`: ${CLI} is missing or older than src/`).toBe(false);
}, 180_000);

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'parley-cli-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * The default config names a whole other deployment — its own db_path, handle and topic allowlist.
 * Falling back to it because an argument was mistyped, or because the shell ate `--config`'s value,
 * starts a bridge against the wrong conversation store with nothing but a discarded stderr line to
 * say so. Every argument this CLI cannot honour has to stop it.
 */
describe('CLI argument parsing refuses what it cannot honour', () => {
  const ENV = { PARLEY_CONFIG: undefined } as unknown as NodeJS.ProcessEnv;

  const CASES: Array<{ argv: string[]; expect: (r: ReturnType<typeof parseArgs>) => void }> = [
    { argv: [], expect: (r) => expect(r).toEqual({ kind: 'run', config: 'parley.config.yaml' }) },
    { argv: ['--config', 'a.yaml'], expect: (r) => expect(r).toEqual({ kind: 'run', config: 'a.yaml' }) },
    { argv: ['-c', 'a.yaml'], expect: (r) => expect(r).toEqual({ kind: 'run', config: 'a.yaml' }) },
    { argv: ['--config=a.yaml'], expect: (r) => expect(r).toEqual({ kind: 'run', config: 'a.yaml' }) },
    { argv: ['--config'], expect: (r) => expect(r.kind).toBe('error') },
    { argv: ['-c'], expect: (r) => expect(r.kind).toBe('error') },
    { argv: ['--config='], expect: (r) => expect(r.kind).toBe('error') },
    { argv: ['--config', '--verbose'], expect: (r) => expect(r.kind).toBe('error') },
    { argv: ['--confg', 'a.yaml'], expect: (r) => expect(r.kind).toBe('error') },
    { argv: ['extra'], expect: (r) => expect(r.kind).toBe('error') },
    { argv: ['--config', 'a.yaml', 'extra'], expect: (r) => expect(r.kind).toBe('error') },
    { argv: ['--help'], expect: (r) => expect(r).toEqual({ kind: 'print', text: USAGE }) },
    { argv: ['--version'], expect: (r) => expect(r).toEqual({ kind: 'print', text: SQLITE_VERSION }) },
  ];

  for (const c of CASES) {
    it(`${JSON.stringify(c.argv)}`, () => {
      c.expect(parseArgs(c.argv, ENV));
    });
  }

  it('PARLEY_CONFIG supplies the default, and --config still wins', () => {
    const env = { PARLEY_CONFIG: 'from-env.yaml' } as unknown as NodeJS.ProcessEnv;
    expect(parseArgs([], env)).toEqual({ kind: 'run', config: 'from-env.yaml' });
    expect(parseArgs(['--config', 'cli.yaml'], env)).toEqual({ kind: 'run', config: 'cli.yaml' });
  });

  it('the shipped binary exits non-zero on a mistyped flag instead of starting a bridge', async () => {
    const dir = tmp();
    const cfgPath = writeConfig(dir);
    const child = spawn(process.execPath, [CLI, '--confg', cfgPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(2);
    expect(stderr).toMatch(/unrecognised argument '--confg'/);
    expect(stderr).not.toMatch(/bridge up/);
  });
});

function writeConfig(
  dir: string,
  extra: Record<string, unknown> = {},
  topLevel: string[] = [],
): string {
  const cfgPath = join(dir, 'parley.config.yaml');
  const cfg = [
    ...topLevel,
    'identity:',
    '  handle: eof-agent',
    // Pin read-state inside this test's tmp dir, so that a run cannot resume from the previous
    // run's cursor: instance_id defaults to the handle, so the default XDG path is shared across
    // runs while `db_path` is fresh each time — and a cursor minted by a deleted store is fatal.
    `state_path: ${join(dir, 'read-state.json')}`,
    'topics:',
    '  - ctx',
    'live_push:',
    '  enabled: true',
    'presence:',
    '  enabled: true',
    '  heartbeat_ms: 500',
    '  ttl_ms: 2000',
    'backend_config:',
    `  db_path: ${join(dir, 'eof.db')}`,
    '  poll_interval_ms: 100',
    ...Object.entries(extra).map(([k, v]) => `  ${k}: ${String(v)}`),
  ].join('\n');
  writeFileSync(cfgPath, cfg + '\n');
  return cfgPath;
}

/**
 * Core validates `catchup.limit` as any positive integer and this plugin refuses a page above
 * MAX_PAGE, so a config core certifies as valid can still stop the bridge — after connect() has
 * opened the store. Either outcome is defensible; a rejection that does not name the key the
 * operator has to change is not, because the only other way to find it is reading plugin source.
 */
describe('a core config value this plugin constrains starts or is refused by name (e2e)', () => {
  const CASES = [
    { limit: 1, starts: true },
    { limit: MAX_PAGE, starts: true },
    { limit: MAX_PAGE + 1, starts: false },
  ];

  for (const { limit, starts } of CASES) {
    it(`catchup.limit ${limit} ${starts ? 'starts the bridge' : 'is refused by name'}`, async () => {
      const dir = tmp();
      const cfgPath = writeConfig(dir, {}, ['catchup:', `  limit: ${limit}`]);
      const child = spawn(process.execPath, [CLI, '--config', cfgPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      const verdict = await new Promise<'up' | 'exited'>((resolve, reject) => {
        const to = setTimeout(() => reject(new Error(`no verdict in 15s: ${stderr}`)), 15_000);
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
          if (stderr.includes('bridge up')) {
            clearTimeout(to);
            resolve('up');
          }
        });
        child.on('exit', () => {
          clearTimeout(to);
          resolve('exited');
        });
      });
      child.stdin.end();
      child.kill('SIGKILL');

      if (starts) {
        expect(verdict).toBe('up');
        return;
      }
      expect(verdict).toBe('exited');
      expect(stderr).not.toMatch(/bridge up/);
      expect(stderr).toMatch(/parley-sqlite: fatal/);
      // The operator's lever, named where they will read it.
      expect(stderr).toContain('catchup.limit');
      expect(stderr).toContain(String(MAX_PAGE));
    });
  }
});

// End-to-end: spawn the built CLI with a piped stdin, wait for "bridge up", then close the
// parent's write end (EOF WITHOUT a signal — the orphaned-parent scenario). The child must run
// shutdown() and EXIT promptly, rather than lingering with the live poll loop + presence heartbeat.
describe('orphaned stdio bridge exits on stdin EOF (e2e)', () => {
  it('exits within a short timeout after the parent closes stdin (no signal)', async () => {
    const dir = tmp();
    const cfgPath = writeConfig(dir);
    const child = spawn(process.execPath, [CLI, '--config', cfgPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for the bridge to be fully up (poll loop + presence heartbeat live) before EOF.
    await new Promise<void>((resolve, reject) => {
      let buf = '';
      const to = setTimeout(() => reject(new Error('bridge did not start: ' + buf)), 10_000);
      child.stderr.on('data', (d: Buffer) => {
        buf += d.toString();
        if (buf.includes('bridge up')) {
          clearTimeout(to);
          resolve();
        }
      });
      child.on('exit', () => {
        clearTimeout(to);
        reject(new Error('child exited before starting: ' + buf));
      });
    });

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    // Close the parent's write end: stdin EOF, no SIGINT/SIGTERM.
    child.stdin.end();

    const result = await Promise.race([
      exit,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
    ]);

    if (result === 'timeout') {
      child.kill('SIGKILL');
      throw new Error('CLI did not exit on stdin EOF within 5s — it kept heart-beating (ghost peer)');
    }
    // Exited with no signal → it ran its own clean shutdown() from the EOF handler.
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
  });
});
