import { readFileSync } from 'node:fs';
import { loadConfig, type ParleyConfig } from '../config.js';
import type { BackendPlugin } from '../seam.js';
import { createStdioBridge } from '../transport/stdio-bridge.js';

/**
 * The one `bin` every backend plugin ships. Ten packages wrote it out, ten distinct files doing one
 * job, and the copies split the shipped bins in half: three parsed argv strictly and answered
 * `--help`, seven fell through their parse loop, so `parley-slack --help` died on a missing config
 * file and `parley-zulip --confg prod.yaml` started a bridge against the default deployment. This
 * is not core reaching into a backend — every one of those entrypoints already composed
 * {@link loadConfig} and {@link createStdioBridge}, which live here; the plugin arrives as an
 * argument and nothing here imports one.
 */

/** The usage text for `bin`, which is the only thing that differed between the ten copies. */
export const usageFor = (bin: string): string => `usage: ${bin} [--config <path>] [--help] [--version]

  -c, --config <path>  config file (default: $PARLEY_CONFIG, else parley.config.yaml)
  -h, --help           print this message
  -V, --version        print the package version`;

export type ParsedArgs =
  | { kind: 'run'; config: string }
  | { kind: 'print'; text: string }
  | { kind: 'error'; message: string };

export interface ParseArgsOptions {
  bin: string;
  version: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Parse a backend bin's arguments. An argument this does not recognise — a typo, or a `--config`
 * whose value the shell ate — is an error rather than a silent fallback to the default config,
 * because the default names a DIFFERENT deployment: another server, credential, handle and topic
 * allowlist, and the only trace is a stderr line an MCP stdio host routinely discards.
 */
export function parseArgs(argv: string[], opts: ParseArgsOptions): ParsedArgs {
  const env = opts.env ?? process.env;
  let config = env['PARLEY_CONFIG'] ?? 'parley.config.yaml';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') return { kind: 'print', text: usageFor(opts.bin) };
    if (arg === '--version' || arg === '-V') return { kind: 'print', text: opts.version };
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

/** The subset of `process` the shutdown wiring touches. */
export interface ShutdownHost {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  stdin: {
    on(event: 'end' | 'close', listener: () => void): unknown;
    readableEnded?: boolean;
    destroyed?: boolean;
  };
}

/**
 * Run `onShutdown` at most once, on a terminating signal or on stdin EOF. Keep both stdin events
 * AND the once-only guard: an orphaned bridge (parent crashed or SIGKILLed) gets EOF and no signal,
 * so without them it heart-beats a ghost peer into every peer's roster — and 'end' followed by
 * 'close', or a signal racing EOF, would otherwise tear the bridge down twice.
 *
 * Keep the two state checks alongside those listeners, so that an EOF which arrived while the
 * bridge was still attaching is still torn down: the MCP stdio transport puts `process.stdin` into
 * flowing mode before `subscribe()` is awaited, so 'end'/'close' can both be emitted — and never
 * re-delivered — before anything here is listening.
 */
export function installShutdown(host: ShutdownHost, onShutdown: () => void): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    onShutdown();
  };
  host.on('SIGINT', shutdown);
  host.on('SIGTERM', shutdown);
  host.stdin.on('end', shutdown);
  host.stdin.on('close', shutdown);
  if (host.stdin.readableEnded === true) shutdown();
  if (host.stdin.destroyed === true) shutdown();
}

export interface BackendCliOptions {
  /** The bin name, as the package's own manifest declares it. */
  bin: string;
  /** The entrypoint's `import.meta.url`; the manifest beside it supplies `--version`. */
  moduleUrl: string;
  /** Built only once argv is known to name a run, so `--version` cannot be answered by a constructor. */
  plugin: () => BackendPlugin;
}

const versionOf = (moduleUrl: string): string =>
  (JSON.parse(readFileSync(new URL('../package.json', moduleUrl), 'utf8')) as { version: string })
    .version;

/**
 * Run a backend's stdio bridge: parse argv, load the config, attach the plugin, and stay up until a
 * signal or stdin EOF. Answers `--help`/`--version` and refuses an argument it cannot honour,
 * exiting BEFORE any transport exists.
 *
 * IMPORTANT: once this process serves MCP, stdout is the JSON-RPC channel — every diagnostic below
 * goes to stderr. Only a branch that exits before the transport is built may write to stdout.
 */
export async function runBackendCli(opts: BackendCliOptions): Promise<void> {
  const { bin } = opts;
  try {
    const args = parseArgs(process.argv.slice(2), { bin, version: versionOf(opts.moduleUrl) });
    if (args.kind === 'print') {
      process.stdout.write(`${args.text}\n`);
      process.exit(0);
    }
    if (args.kind === 'error') {
      process.stderr.write(`${bin}: ${args.message}\n${usageFor(bin)}\n`);
      process.exit(2);
    }
    const cfg: ParleyConfig = loadConfig(args.config);
    const bridge = await createStdioBridge(opts.plugin(), cfg);
    process.stderr.write(
      `${bin}: bridge up — handle=${cfg.identity.handle} topics=[${cfg.topics.join(', ')}] ` +
        `live_push=${String(cfg.live_push.enabled)}\n`,
    );
    installShutdown(process, () => {
      void bridge.shutdown().finally(() => process.exit(0));
    });
  } catch (err: unknown) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`${bin}: fatal: ${detail}\n`);
    process.exit(1);
  }
}
