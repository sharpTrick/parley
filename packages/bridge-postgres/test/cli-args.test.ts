import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ParsedArgs, parseArgs, POSTGRES_VERSION, USAGE } from '../src/args.js';

// The default config names a whole other deployment — its own database url, table, handle and topic
// allowlist. Falling back to it because an argument was mistyped, or because the shell ate
// `--config`'s value, starts a bridge against the wrong conversation store with nothing but a
// stderr line an MCP stdio host routinely discards to say so. Every argument this CLI cannot honour
// has to stop it.
//
// The entrypoints are read out of the manifest rather than named here, so a second `bin` added to
// this package is graded the day it lands; and each row is driven BOTH through the parser and
// through the built binary, because a parser that refuses correctly guards nothing if the
// entrypoint does not consult it.

const PKG = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const REPO = join(PKG, '..', '..');

const BINS = Object.entries(
  (JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { bin?: Record<string, string> })
    .bin ?? {},
).map(([name, path]) => [name, join(PKG, path)] as const);

/** Newest mtime among the sources tsc emits, so a spawn cannot pass against a stale `dist/`. */
function newestSourceMtime(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((newest, e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return Math.max(newest, newestSourceMtime(p));
    if (!e.name.endsWith('.ts')) return newest;
    return Math.max(newest, statSync(p).mtimeMs);
  }, 0);
}

beforeAll(() => {
  const stale = (): boolean =>
    BINS.some(([, path]) => {
      try {
        return statSync(path).mtimeMs < newestSourceMtime(join(PKG, 'src'));
      } catch {
        return true;
      }
    });
  if (!stale()) return;
  // --force, so that a deleted dist rebuilds: tsbuildinfo sits outside dist and otherwise reports
  // the project up to date while the artifact these cases execute is gone.
  execFileSync('npx', ['tsc', '-b', 'packages/bridge-postgres', '--force'], {
    cwd: REPO,
    stdio: 'pipe',
  });
  expect(stale(), 'run `npm run build`: a bin is missing or older than src/').toBe(false);
}, 180_000);

/** An argv the CLI cannot honour, and the argument its refusal has to name. */
const REFUSED: [argv: string[], offender: string][] = [
  [['--confg', 'parley.prod.yaml'], '--confg'],
  [['--config'], '--config'],
  [['-c'], '-c'],
  [['--config='], '--config='],
  [['--config', '--verbose'], '--config'],
  [['-config', 'x.yaml'], '-config'],
  [['--unknown'], '--unknown'],
  [['extra'], 'extra'],
  [['--config', 'a.yaml', 'extra'], 'extra'],
];

const HONOURED: [argv: string[], parsed: ParsedArgs][] = [
  [[], { kind: 'run', config: 'parley.config.yaml' }],
  [['--config', 'a.yaml'], { kind: 'run', config: 'a.yaml' }],
  [['-c', 'a.yaml'], { kind: 'run', config: 'a.yaml' }],
  [['--config=a.yaml'], { kind: 'run', config: 'a.yaml' }],
  [['--help'], { kind: 'print', text: USAGE }],
  [['-h'], { kind: 'print', text: USAGE }],
  [['--version'], { kind: 'print', text: POSTGRES_VERSION }],
  [['-V'], { kind: 'print', text: POSTGRES_VERSION }],
];

describe('the CLI refuses every argument it cannot honour', () => {
  it('this package publishes entrypoints, so the spawned cases below are not vacuous', () => {
    expect(BINS.length).toBeGreaterThan(0);
  });

  it.each(REFUSED)('%j is an error naming %s', (argv, offender) => {
    const parsed = parseArgs(argv, {});
    expect(parsed.kind, 'this argv silently started the default deployment').toBe('error');
    expect(parsed.kind === 'error' ? parsed.message : '').toContain(offender);
  });

  it.each(HONOURED)('%j parses to the argument it names', (argv, parsed) => {
    expect(parseArgs(argv, {})).toEqual(parsed);
  });

  it('PARLEY_CONFIG supplies the default and an explicit --config beats it', () => {
    const env = { PARLEY_CONFIG: 'env.yaml' };
    expect(parseArgs([], env)).toEqual({ kind: 'run', config: 'env.yaml' });
    expect(parseArgs(['--config', 'flag.yaml'], env)).toEqual({ kind: 'run', config: 'flag.yaml' });
  });
});

const SPAWNED = BINS.flatMap(([name, path]) =>
  REFUSED.map(
    ([argv, offender]) =>
      [`${name} ${argv.join(' ')} — refused, naming ${offender}`, path, argv, offender] as const,
  ),
);

describe('the built entrypoint consults that parser rather than its own', () => {
  it.each(SPAWNED)('%s', (_label, path, argv, offender) => {
    const run = spawnSync(process.execPath, [path, ...argv], { encoding: 'utf8', timeout: 30_000 });
    expect(run.status, 'the CLI started a bridge instead of refusing').toBe(2);
    expect(run.stderr).toContain(offender);
    expect(run.stdout, 'stdout is the JSON-RPC channel — diagnostics belong on stderr').toBe('');
  }, 30_000);

  it.each(BINS)('%s --help prints usage on stdout and exits 0', (_name, path) => {
    const run = spawnSync(process.execPath, [path, '--help'], { encoding: 'utf8', timeout: 30_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('usage:');
  }, 30_000);
});
