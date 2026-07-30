import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { vi } from 'vitest';
import type { SqlDriver } from '../src/driver.js';
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

/**
 * Both drivers SHIP: better-sqlite3 is an optionalDependency, so a platform with no prebuilt binary
 * and no toolchain runs the `node:sqlite` fallback for real. Certifying the seam against whichever
 * one `openDriver` happened to resolve certifies one of two shipped configurations — paging at every
 * limit, exclusive-`since`, the blocking-fetch race, the interleaved-writer and multi-process cases
 * were graded for the incumbent only, and a divergence in bigint binding, in `changes` /
 * `lastInsertRowid` typing or in `all()` row prototypes would ship green. So the driver is a
 * DIMENSION of this file rather than an ambient fact, and every present and future clause is graded
 * on both.
 */
type Kind = SqlDriver['kind'];

/**
 * Load a copy of the plugin with `better-sqlite3` made to look absent, exactly as an un-prebuilt
 * install does. The memoized constructor in driver.ts is why this needs a module reset rather than
 * a flag; driver-parity.test.ts uses the same trick for its narrower cases.
 */
async function loadFallbackPlugin(): Promise<typeof SqlitePlugin> {
  vi.resetModules();
  vi.doMock('node:module', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:module')>();
    return {
      ...real,
      default: real,
      createRequire: (from: string | URL) => {
        const inner = real.createRequire(from);
        const absent = ((id: string) => {
          if (id === 'better-sqlite3') {
            throw Object.assign(new Error(`Cannot find module '${id}'`), {
              code: 'MODULE_NOT_FOUND',
            });
          }
          return inner(id) as unknown;
        }) as unknown as NodeJS.Require;
        return Object.assign(absent, inner);
      },
    };
  });
  const index = await import('../src/index.js');
  return index.SqlitePlugin;
}

const load = (kind: Kind): Promise<typeof SqlitePlugin> =>
  kind === 'node:sqlite' ? loadFallbackPlugin() : Promise.resolve(SqlitePlugin);

for (const kind of ['better-sqlite3', 'node:sqlite'] as Kind[]) {
  runConformanceSuite(`sqlite (${kind})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parley-conf-'));
    const dbPath = join(dir, 'p.db');
    const Plugin = await load(kind);
    const plugin = new Plugin();
    await plugin.connect({ db_path: dbPath, poll_interval_ms: 20 });
    // A fallback that silently resolved the incumbent would certify better-sqlite3 twice and report
    // the fallback as graded, which is the exact failure this dimension exists to end.
    const active = (plugin as unknown as { driver: SqlDriver }).driver.kind;
    if (active !== kind) {
      await plugin.disconnect();
      throw new Error(`conformance for ${kind} ran against the ${active} driver`);
    }
    return {
      plugin,
      freshTopic: (): Topic => asTopic(`t-${++topicSeq}`),
      carriesSenderIdentity: true,
      supportsBlockingFetch: false,
      cleanup: async () => {
        await plugin.disconnect();
        rmSync(dir, { recursive: true, force: true });
        vi.doUnmock('node:module');
      },
      // One of the contending writers is the plugin itself, writing through the shipped `post()`
      // while the forked processes are still running — otherwise the check would prove the fixture's
      // hand-rolled write path safe and never touch the code that ships.
      concurrentPost: async (topic: Topic, writers: number, perWriter: number) => {
        const children = forkWriters(dbPath, topic, writers - 1, perWriter);
        for (let i = 0; i < perWriter; i++) {
          await plugin.post(topic, asHandle('plugin'), `plugin-${i}`);
        }
        await children;
      },
    };
  });
}
