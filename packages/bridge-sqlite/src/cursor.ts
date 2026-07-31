import { randomBytes } from 'node:crypto';
import {
  asCursor,
  asTopic,
  buildMessage,
  type Cursor,
  type Message,
} from '@sharptrick/parley-core';
import { describe } from './config.js';
import type { SqlDriver } from './driver.js';
import { type MessageRow, STORE_ID_KEY } from './schema.js';

/**
 * Shape of `parley_meta.store_id`. Keep the mint side, the parse side and the connect-time check
 * deriving from THIS one pattern, so that the plugin cannot mint a cursor its own parser rejects.
 */
const STORE_ID_PATTERN = '[0-9a-f]{16}';
const STORE_ID_RE = new RegExp(`^${STORE_ID_PATTERN}$`);

/**
 * A cursor is `<storeId>.<rowid>`. A bare `<rowid>` parses with no store id — this backend before
 * cursors carried identity, or another backend's numeric cursor — and names nothing here, so
 * `resumeAfter` replays instead of trusting it.
 */
const CURSOR_RE = new RegExp(`^(?:(${STORE_ID_PATTERN})\\.)?(\\d+)$`);

export function parseCursor(raw: string): { storeId?: string; rowid: bigint } | undefined {
  const m = CURSOR_RE.exec(raw);
  if (m === null) return undefined;
  return { storeId: m[1], rowid: BigInt(m[2] ?? '0') };
}

export function mintCursor(storeId: string, rowid: number | bigint): Cursor {
  return asCursor(`${storeId}.${rowid}`);
}

/**
 * This store's identity, minted once and persisted. `INSERT OR IGNORE` then read back, so that
 * two bridge processes racing a brand-new file agree on whichever id landed first. The read-back
 * is checked against the cursor grammar rather than trusted: it is written into every cursor this
 * store mints, so a value the parser cannot place would make the plugin mint cursors it rejects on
 * the next catch-up — which core propagates, so every bridge sharing the file fails to start.
 */
export function readOrMintStoreId(driver: SqlDriver, dbPath: string): string {
  const mint = driver.prepare('INSERT OR IGNORE INTO parley_meta (key, value) VALUES (?, ?)');
  mint.run(STORE_ID_KEY, randomBytes(8).toString('hex'));
  const read = driver.prepare('SELECT value FROM parley_meta WHERE key = ?');
  const row = read.get(STORE_ID_KEY) as { value: string } | undefined;
  if (row === undefined) {
    throw new Error('parley-sqlite: could not establish a store id in parley_meta');
  }
  if (!STORE_ID_RE.test(row.value)) {
    throw new Error(
      `parley-sqlite: ${dbPath} carries an unusable parley_meta.${STORE_ID_KEY} ` +
        `${describe(row.value)} — expected ${STORE_ID_PATTERN}. Every cursor this backend mints ` +
        `carries it, so this store would hand out cursors its own parser rejects; restore the ` +
        `original value, or delete the row to mint a fresh identity (readers then replay rather ` +
        `than skip)`,
    );
  }
  return row.value;
}

export function rowToMessage(row: MessageRow, storeId: string): Message {
  return buildMessage({
    topic: asTopic(row.topic),
    sender: row.sender,
    content: row.content,
    timestamp: row.ts,
    id: String(row.id),
    cursor: mintCursor(storeId, row.id),
  });
}
