#!/usr/bin/env node
import { createStdioBridge, loadConfig, type ParleyConfig } from '@sharptrick/parley-core';
import { parseArgs, USAGE } from './args.js';
import { SqlitePlugin } from './index.js';

// IMPORTANT: this is an MCP stdio server — stdout is the JSON-RPC channel. All diagnostics go
// to stderr; never write to stdout here.

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.kind === 'print') {
    process.stderr.write(`${args.text}\n`);
    process.exit(0);
  }
  if (args.kind === 'error') {
    process.stderr.write(`parley-sqlite: ${args.message}\n${USAGE}\n`);
    process.exit(2);
  }
  const cfg: ParleyConfig = loadConfig(args.config);
  const plugin = new SqlitePlugin();
  const bridge = await createStdioBridge(plugin, cfg);
  process.stderr.write(
    `parley-sqlite: bridge up — handle=${cfg.identity.handle} topics=[${cfg.topics.join(', ')}] ` +
      `live_push=${String(cfg.live_push.enabled)}\n`,
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void bridge.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // An orphaned bridge (parent crashed or SIGKILLed) gets stdin EOF and no signal, so keep these,
  // so that it stops rather than heart-beating a ghost peer into every peer's roster.
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`parley-sqlite: fatal: ${detail}\n`);
  process.exit(1);
});
