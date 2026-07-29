// Standalone concurrent writer for the multi-process write-safety conformance test.
//
// It mirrors SqlitePlugin's write path (driver.ts open with WAL + busy_timeout, then the
// messages INSERT) WITHOUT importing the compiled package, so the test needs no prior build.
// Run as a forked OS process:  node concurrent-writer.mjs <dbPath> <topic> <count> <sender>
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function openDb(path) {
  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(path);
  } catch {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(path);
  }
  // Keep the same pragma order as driver.ts — busy_timeout first, then a bounded-retried WAL
  // conversion — so that a first-boot race against another opener degrades instead of crashing.
  db.exec('PRAGMA busy_timeout = 5000');
  for (let i = 0; ; i++) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      break;
    } catch (e) {
      if (i >= 20) {
        // Degrade to the default journal mode rather than crash the writer.
        process.stderr.write(
          `concurrent-writer: WAL conversion still busy after ${i} retries; ` +
            `continuing in default journal mode: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        break;
      }
      const sab = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sab, 0, 0, 5 + i);
    }
  }
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

const [dbPath, topic, countStr, sender] = process.argv.slice(2);
const count = Number(countStr);

const db = openDb(dbPath);
// Idempotent: the writer may race the plugin's own CREATE, and either may win. Keep this text
// byte-identical to SCHEMA in src/schema.ts — whichever process creates the file decides the
// shape for every other one. test/multi-process.test.ts compares the two DDLs and fails on drift.
db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic       TEXT NOT NULL,
  sender      TEXT NOT NULL,
  content     TEXT NOT NULL,
  ts          TEXT NOT NULL,           -- ISO 8601, informational only
  in_reply_to TEXT                     -- backendMsgId this threads under, or NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_topic_id ON messages(topic, id);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
CREATE TABLE IF NOT EXISTS parley_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
const stmt = db.prepare(
  'INSERT INTO messages (topic, sender, content, ts, in_reply_to) VALUES (?, ?, ?, ?, ?)',
);
const ts = new Date().toISOString();
for (let i = 0; i < count; i++) {
  stmt.run(topic, sender, `${sender}-${i}`, ts, null);
}
db.close();
