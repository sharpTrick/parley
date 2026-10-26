import { describe, expect, it } from 'vitest';
import { parseArgs, usageFor, type ParsedArgs } from './backend-cli.js';

/**
 * CLASS: an argv the CLI cannot honour must stop it. The default config names a whole other
 * deployment — its own server, credential, handle and topic allowlist — so falling back to it
 * because an argument was mistyped, or because the shell ate `--config`'s value, brings a bridge up
 * against the wrong conversation store and posts agent output into topics the operator never
 * selected, with nothing but a stderr line an MCP stdio host routinely discards to say so.
 *
 * The rows are generated from the flags the usage text DECLARES, not hand-listed, so a flag added
 * later is graded before it has a bug. Whether each shipped `bin` actually consults this parser is
 * the other half, and it is asserted over every manifest that declares one in
 * `packages/conformance/test/published-bins.test.ts` — a parser that refuses correctly guards
 * nothing if seven of ten entrypoints inline a weaker one, which is what these rows used to grade
 * in four separate copies.
 */

const BIN = 'parley-example';
const USAGE = usageFor(BIN);
const VERSION = '9.9.9';
const OPTS = { bin: BIN, version: VERSION, env: {} };

/** Flags that take a path, and flags that take none — read off the usage text rather than restated. */
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
  [['--version'], { kind: 'print', text: VERSION }],
  [['-V'], { kind: 'print', text: VERSION }],
];

describe('the shared backend CLI refuses every argument it cannot honour', () => {
  it('every flag the usage text declares is covered by the rows below', () => {
    expect(DECLARED.length).toBeGreaterThan(0);
    expect(
      DECLARED.filter((flag) => ![...TAKES_VALUE, ...TAKES_NONE].includes(flag)),
      'a flag was added to the usage text with no rows generated for it',
    ).toEqual([]);
  });

  it.each(REFUSED)('%j is an error naming %s', (argv, offender) => {
    const parsed = parseArgs(argv, OPTS);
    expect(parsed.kind, 'this argv silently started the default deployment').toBe('error');
    expect(parsed.kind === 'error' ? parsed.message : '').toContain(offender);
  });

  it.each(HONOURED)('%j parses to the argument it names', (argv, parsed) => {
    expect(parseArgs(argv, OPTS)).toEqual(parsed);
  });

  it('PARLEY_CONFIG supplies the default and an explicit --config beats it', () => {
    const env = { PARLEY_CONFIG: 'env.yaml' };
    expect(parseArgs([], { ...OPTS, env })).toEqual({ kind: 'run', config: 'env.yaml' });
    expect(parseArgs(['--config', 'flag.yaml'], { ...OPTS, env })).toEqual({
      kind: 'run',
      config: 'flag.yaml',
    });
  });

  // The usage text is the one thing that differed between the ten copies, so it is the one thing a
  // shared parser has to keep per-bin: a message naming the wrong command is a message an operator
  // cannot follow.
  it('names the bin it was built for, and nothing else', () => {
    expect(usageFor('parley-zulip')).toContain('usage: parley-zulip ');
    expect(usageFor('parley-zulip')).not.toContain('parley-example');
    const help = parseArgs(['--help'], { ...OPTS, bin: 'parley-zulip' });
    expect(help.kind === 'print' ? help.text : '').toBe(usageFor('parley-zulip'));
  });
});
