// Holds a SQLite write lock on an existing DB file for a bounded time, from a *separate OS
// process*, so the parent can prove that the shipped write path retries (busy_timeout) instead of
// erroring. Touches no schema — it only takes and releases the lock.
//   node lock-holder.mjs <dbPath> <holdMs>   → sends 'locked' over IPC, then commits and exits.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const [dbPath, holdMsStr] = process.argv.slice(2);

function open(path) {
  try {
    const Database = require('better-sqlite3');
    return new Database(path);
  } catch {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(path);
  }
}

const db = open(dbPath);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
process.send?.('locked');
const sab = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(sab, 0, 0, Number(holdMsStr));
db.exec('COMMIT');
db.close();
