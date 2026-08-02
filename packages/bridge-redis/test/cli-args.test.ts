import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ParsedArgs, parseArgs, REDIS_VERSION, USAGE } from '../src/args.js';

// CLASS: an argv the CLI cannot honour must stop it. The default config names a whole other
// deployment — its own url, key_prefix, handle and topic allowlist — so falling back to it because
// an argument was mistyped, or because the shell ate `--config`'s value, starts a bridge against
// the wrong conversation store and posts agent output into topics the operator never selected,
// with nothing but a stderr line an MCP stdio host routinely discards to say so.
//
// The rows are generated from the flags USAGE declares, not hand-listed, so a flag added later is
// graded before it has a bug; the entrypoints come from the manifest, so a second `bin` is graded
// the day it lands; and each row runs BOTH through the parser and through the built binary, because
// a parser that refuses correctly guards nothing if the entrypoint does not consult it.

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
  execFileSync('npx', ['tsc', '-b', 'packages/bridge-redis', '--force'], {
    cwd: REPO,
    stdio: 'pipe',
  });
  expect(stale(), 'run `npm run build`: a bin is missing or older than src/').toBe(false);
}, 180_000);

/** Flags that take a path, and flags that take none — read off USAGE rather than restated here. */
const DECLARED = [...USAGE.matchAll(/(?:^|[\s,[])(--?[\w-]+)/gm)].map((m) => m[1] ?? '');
const TAKES_VALUE = ['--config', '-c'];
const TAKES_NONE = ['--help', '-h', '--version', '-V'];

/** One character changed, and one character dropped — a typo the shell will not catch. */
const typosOf = (flag: string): string[] => [`${flag.slice(0, -1)}z`, flag.slice(0, -1)];

/** A double-dash flag spelled with one dash, which getopt-style parsers quietly accept elsewhere. */
const singleDash = (flag: string): string[] => (flag.startsWith('--') ? [flag.slice(1)] : []);

/** An argv the CLI cannot honour, and the argument its refusal has to name. */
const REFUSED: Array<[argv: string[], offender: string]> = [
  ...TAKES_VALUE.flatMap((flag): Array<[string[], string]> => [
    [[flag], flag],
    [[flag, '--help'], flag],
    ...typosOf(flag).map((typo): [string[], string] => [[typo, 'parley.prod.yaml'], typo]),
    ...singleDash(flag).map((dashed): [string[], string] => [[dashed, 'x.yaml'], dashed]),
  ]),
  ...TAKES_NONE.flatMap((flag): Array<[string[], string]> => [
    ...typosOf(flag).map((typo): [string[], string] => [[typo], typo]),
    ...singleDash(flag).map((dashed): [string[], string] => [[dashed], dashed]),
  ]),
  [['--config='], '--config='],
  [['--unknown'], '--unknown'],
  [['parley.prod.yaml'], 'parley.prod.yaml'],
  [['--config', 'a.yaml', 'extra'], 'extra'],
];

const HONOURED: Array<[argv: string[], parsed: ParsedArgs]> = [
  [[], { kind: 'run', config: 'parley.config.yaml' }],
  ...TAKES_VALUE.flatMap((flag): Array<[string[], ParsedArgs]> => [
    [[flag, 'a.yaml'], { kind: 'run', config: 'a.yaml' }],
  ]),
  [['--config=a.yaml'], { kind: 'run', config: 'a.yaml' }],
  [['--help'], { kind: 'print', text: USAGE }],
  [['-h'], { kind: 'print', text: USAGE }],
  [['--version'], { kind: 'print', text: REDIS_VERSION }],
  [['-V'], { kind: 'print', text: REDIS_VERSION }],
];

describe('the CLI refuses every argument it cannot honour', () => {
  it('every flag USAGE declares is covered by the rows below', () => {
    expect(DECLARED.length).toBeGreaterThan(0);
    expect(
      DECLARED.filter((flag) => ![...TAKES_VALUE, ...TAKES_NONE].includes(flag)),
      'a flag was added to USAGE with no rows generated for it',
    ).toEqual([]);
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

const DISTINCT = [...new Map(REFUSED.map((row) => [row[0].join(' '), row])).values()];

const SPAWNED = BINS.flatMap(([name, path]) =>
  DISTINCT.map(
    ([argv, offender]) =>
      [`${name} ${argv.join(' ')} — refused, naming ${offender}`, path, argv, offender] as const,
  ),
);

describe('the built entrypoint consults that parser rather than its own', () => {
  it('this package publishes entrypoints, so the spawned cases below are not vacuous', () => {
    expect(BINS.length).toBeGreaterThan(0);
  });

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
