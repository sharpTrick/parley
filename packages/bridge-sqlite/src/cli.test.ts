import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// The built CLI (dist/cli.js) — the real orphaning drive runs the compiled entrypoint as a child.
const CLI = join(here, '..', 'dist', 'cli.js');

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'parley-cli-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// BUG-38 (unit): the CLI's stdin EOF/close wiring must run shutdown() and must be idempotent under
// the shuttingDown guard — 'end' + 'close' (or a signal racing EOF) must call shutdown ONCE. This
// mirrors the exact wiring in cli.ts against a stdin stub.
describe('stdin EOF shutdown wiring is idempotent (BUG-38, unit)', () => {
  it('runs shutdown exactly once across end + close', async () => {
    const stdin = new EventEmitter();
    let shutdownCalls = 0;
    // Replicate cli.ts's guarded shutdown wiring verbatim.
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      shutdownCalls++;
    };
    stdin.on('end', shutdown);
    stdin.on('close', shutdown);

    stdin.emit('end');
    stdin.emit('close'); // second event must be a no-op thanks to the guard
    expect(shutdownCalls).toBe(1);
  });
});

function writeConfig(dir: string, extra: Record<string, unknown> = {}): string {
  const cfgPath = join(dir, 'parley.config.yaml');
  const cfg = [
    'identity:',
    '  handle: eof-agent',
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

// BUG-38 (end-to-end): spawn the built CLI with a piped stdin, wait for "bridge up", then close the
// parent's write end (EOF WITHOUT a signal — the orphaned-parent scenario). The child must run
// shutdown() and EXIT promptly, rather than lingering with the live poll loop + presence heartbeat.
describe('orphaned stdio bridge exits on stdin EOF (BUG-38, e2e)', () => {
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
