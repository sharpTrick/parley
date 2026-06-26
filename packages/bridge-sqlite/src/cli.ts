#!/usr/bin/env node
import { createStdioBridge, loadConfig, type ParleyConfig } from '@parley/core';
import { SqlitePlugin } from './index.js';

// IMPORTANT: this is an MCP stdio server — stdout is the JSON-RPC channel. All diagnostics go
// to stderr; never write to stdout here.

interface CliArgs {
  config: string;
}

function parseArgs(argv: string[]): CliArgs {
  let config = process.env.PARLEY_CONFIG ?? 'parley.config.yaml';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config' || arg === '-c') {
      const next = argv[i + 1];
      if (next !== undefined) {
        config = next;
        i++;
      }
    } else if (arg !== undefined && arg.startsWith('--config=')) {
      config = arg.slice('--config='.length);
    }
  }
  return { config };
}

async function main(): Promise<void> {
  const { config } = parseArgs(process.argv.slice(2));
  const cfg: ParleyConfig = loadConfig(config);
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
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`parley-sqlite: fatal: ${detail}\n`);
  process.exit(1);
});
