import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConformanceSuite } from '@parley/conformance';
import { asTopic, type Topic } from '@parley/core';
import { SqlitePlugin } from '../src/index.js';

// Forked OS-process writer (plain .mjs; no build needed) — the strongest proof of WAL +
// busy_timeout concurrent-write safety is genuinely separate processes hitting one DB file.
const writerScript = fileURLToPath(new URL('../src/concurrent-writer.mjs', import.meta.url));

let topicSeq = 0;

function forkWriters(
  dbPath: string,
  topic: string,
  writers: number,
  perWriter: number,
): Promise<void> {
  const procs = Array.from(
    { length: writers },
    (_unused, i) =>
      new Promise<void>((resolve, reject) => {
        const child = fork(writerScript, [dbPath, topic, String(perWriter), `w${i}`]);
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`writer ${i} exited with code ${String(code)}`)),
        );
        child.on('error', reject);
      }),
  );
  return Promise.all(procs).then(() => undefined);
}

runConformanceSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-conf-'));
  const dbPath = join(dir, 'p.db');
  const plugin = new SqlitePlugin();
  await plugin.connect({ db_path: dbPath, poll_interval_ms: 20 });
  return {
    plugin,
    freshTopic: (): Topic => asTopic(`t-${++topicSeq}`),
    cleanup: async () => {
      await plugin.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
    concurrentPost: (topic: Topic, writers: number, perWriter: number) =>
      forkWriters(dbPath, topic, writers, perWriter),
  };
});
