#!/usr/bin/env node
import { createStdioBridge, loadConfig, type ParleyConfig } from '@sharptrick/parley-core';
import { parseArgs, USAGE } from './args.js';
import { XmppPlugin } from './index.js';

// IMPORTANT: once this process serves MCP, stdout is the JSON-RPC channel — keep every diagnostic
// below on stderr. Only a branch that exits BEFORE the transport exists may write to stdout.

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.kind === 'print') {
    process.stdout.write(`${args.text}\n`);
    process.exit(0);
  }
  if (args.kind === 'error') {
    process.stderr.write(`parley-xmpp: ${args.message}\n${USAGE}\n`);
    process.exit(2);
  }
  const cfg: ParleyConfig = loadConfig(args.config);
  const plugin = new XmppPlugin();
  const bridge = await createStdioBridge(plugin, cfg);
  process.stderr.write(
    `parley-xmpp: bridge up — handle=${cfg.identity.handle} topics=[${cfg.topics.join(', ')}] ` +
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
  process.stderr.write(`parley-xmpp: fatal: ${detail}\n`);
  process.exit(1);
});
