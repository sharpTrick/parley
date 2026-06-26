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
  // Same pragmas as driver.ts: WAL + busy_timeout make concurrent multi-process writes safe.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

const [dbPath, topic, countStr, sender] = process.argv.slice(2);
const count = Number(countStr);

const db = openDb(dbPath);
// Idempotent: the writer may race the plugin's own CREATE.
db.exec(
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     topic TEXT NOT NULL, sender TEXT NOT NULL, content TEXT NOT NULL,
     ts TEXT NOT NULL, in_reply_to TEXT
   )`,
);
const stmt = db.prepare(
  'INSERT INTO messages (topic, sender, content, ts, in_reply_to) VALUES (?, ?, ?, ?, ?)',
);
const ts = new Date().toISOString();
for (let i = 0; i < count; i++) {
  stmt.run(topic, sender, `${sender}-${i}`, ts, null);
}
db.close();
