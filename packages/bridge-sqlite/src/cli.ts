#!/usr/bin/env node
import { createStdioBridge, loadConfig, type ParleyConfig } from '@sharptrick/parley-core';
import { parseArgs, USAGE } from './args.js';
import { SqlitePlugin } from './index.js';
import { installShutdown } from './shutdown.js';

// IMPORTANT: once this process serves MCP, stdout is the JSON-RPC channel — keep every diagnostic
// below on stderr. Only a branch that exits BEFORE the transport exists may write to stdout.

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.kind === 'print') {
    process.stdout.write(`${args.text}\n`);
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

  installShutdown(process, () => {
    void bridge.shutdown().finally(() => process.exit(0));
  });
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`parley-sqlite: fatal: ${detail}\n`);
  process.exit(1);
});
