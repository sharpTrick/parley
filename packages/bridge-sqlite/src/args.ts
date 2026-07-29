import { readFileSync } from 'node:fs';

export const USAGE = `usage: parley-sqlite [--config <path>] [--help] [--version]

  -c, --config <path>  config file (default: $PARLEY_CONFIG, else parley.config.yaml)
  -h, --help           print this message
  -V, --version        print the package version`;

export const SQLITE_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

export type ParsedArgs =
  | { kind: 'run'; config: string }
  | { kind: 'print'; text: string }
  | { kind: 'error'; message: string };

/**
 * Parse the CLI's arguments. An argument this does not recognise — a typo, or a `--config` whose
 * value the shell ate — is an error rather than a silent fallback to the default config, because
 * the default names a different deployment: another db_path, handle and topic allowlist, and the
 * only trace is a stderr line an MCP stdio host routinely discards.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  let config = env['PARLEY_CONFIG'] ?? 'parley.config.yaml';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') return { kind: 'print', text: USAGE };
    if (arg === '--version' || arg === '-V') return { kind: 'print', text: SQLITE_VERSION };
    if (arg === '--config' || arg === '-c') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { kind: 'error', message: `${arg} requires a path` };
      }
      config = next;
      i++;
    } else if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (value === '') return { kind: 'error', message: '--config= requires a path' };
      config = value;
    } else {
      return { kind: 'error', message: `unrecognised argument '${arg}'` };
    }
  }
  return { kind: 'run', config };
}
