import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectPoisonCostsOneMessage, POISON_RECORD_CLAUSE } from '@sharptrick/parley-conformance';
import { asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, beforeEach, it, vi } from 'vitest';
import { SqlitePlugin } from '../src/index.js';

/**
 * This backend's poison record: `content` is declared `TEXT NOT NULL`, but SQLite's TEXT affinity
 * does not CONVERT a BLOB, so any peer writing the same file can leave a row whose `content` comes
 * back as a Buffer — and `rowToMessage` -> `buildMessage` -> `parseMentions` throws on it. Planted
 * from a second connection for exactly that reason: the plugin's own `post` cannot write one.
 */
const require = createRequire(import.meta.url);

interface RawDb {
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
}

const T = asTopic('poison');
const INTERVAL_MS = 1000;

let plugin: SqlitePlugin;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await plugin.disconnect();
  vi.useRealTimers();
});

it(POISON_RECORD_CLAUSE, async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'parley-poison-')), 'p.db');
  plugin = new SqlitePlugin();
  await plugin.connect({ db_path: dbPath, poll_interval_ms: INTERVAL_MS });

  const delivered: Message[] = [];
  await plugin.subscribe(T, (m) => {
    delivered.push(m);
  });

  await expectPoisonCostsOneMessage({
    survivors: ['first', 'third'],
    plant: () => {
      const Database = require('better-sqlite3') as new (path: string) => RawDb;
      const peer = new Database(dbPath);
      const insert = peer.prepare(
        'INSERT INTO messages (topic, sender, content, ts) VALUES (?, ?, ?, ?)',
      );
      const ts = new Date().toISOString();
      insert.run(T, 'alice', 'first', ts);
      insert.run(T, 'alice', Buffer.from([0x00, 0xff]), ts);
      insert.run(T, 'alice', 'third', ts);
      peer.close();
    },
    settle: async () => {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    },
    delivered: () => delivered.map((m) => m.content),
  });
});
