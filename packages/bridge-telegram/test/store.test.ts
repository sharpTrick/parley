import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyOf, ObservedStore, type StoredRecord } from '../src/store.js';

const record = (chatId: string, messageId: number, content: string): StoredRecord => ({
  chat_id: chatId,
  message_id: messageId,
  sender: 's',
  content,
  ts: new Date().toISOString(),
});

const lineCount = (path: string): number => {
  const raw = readFileSync(path, 'utf8');
  return raw === '' ? 0 : raw.trimEnd().split('\n').length;
};

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'parley-tg-store-'));
  path = join(dir, 'store.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * BUG-19 / BUG-32: the observed-message store must repair a crash-torn tail on load and hold
 * its retention bounds at ALL times — a bound that only bites at load is no bound at all for a
 * bridge that never restarts.
 */
describe('telegram ObservedStore durability (BUG-19 / BUG-32)', () => {
  it('BUG-19: repairs a crash-torn tail so a later append survives a cold reload', () => {
    // One complete record, then a crash-torn fragment of a second (NO trailing newline).
    writeFileSync(path, `${JSON.stringify(record('1', 1, 'first'))}\n{"chat_id":"1","mess`);

    const store = new ObservedStore(path);
    const recC = record('1', 3, 'third');
    expect(store.append(recC)).toBe(true);
    store.close();

    const reloaded = new ObservedStore(path);
    // The complete record survives, the fragment is dropped, and the append is NOT glued/lost.
    expect(reloaded.entries('1').map((r) => r.content)).toEqual(['first', 'third']);
    expect(reloaded.has(keyOf(recC))).toBe(true);
    reloaded.close();
  });

  it('BUG-32: bounds a pre-written file to newest-N, compacts it, and frees the fd on close', () => {
    const N = 5;
    const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify(record('1', i + 1, `m${i + 1}`)));
    writeFileSync(path, `${lines.join('\n')}\n`);

    const store = new ObservedStore(path, N);
    expect(store.entries('1').map((r) => r.message_id)).toEqual([16, 17, 18, 19, 20]);
    // The dedup set is bounded too: evicted (old) ids gone, retained ids present.
    expect(store.has(keyOf(record('1', 1, '')))).toBe(false);
    expect(store.has(keyOf(record('1', 20, '')))).toBe(true);
    store.close();

    // After close the fd is released: a further append is a no-op (does not touch the file).
    expect(store.append(record('1', 99, 'x'))).toBe(false);
    expect(lineCount(path)).toBe(N);

    const reloaded = new ObservedStore(path, N);
    expect(reloaded.entries('1').map((r) => r.content)).toEqual(['m16', 'm17', 'm18', 'm19', 'm20']);
    reloaded.close();
  });

  /**
   * The bound is a runtime invariant, not a load-time snapshot: appends far past the bound must
   * leave memory, the dedup set and the file bounded — the live path is where a long-lived
   * bridge on a busy chat actually spends its life.
   */
  const RETENTION_CASES = [
    { maxPerChat: 1, appends: 25, chats: 1 },
    { maxPerChat: 3, appends: 40, chats: 1 },
    { maxPerChat: 3, appends: 30, chats: 4 },
    { maxPerChat: 10, appends: 250, chats: 2 },
  ];

  it.each(RETENTION_CASES)(
    'holds newest-$maxPerChat across $appends appends x $chats chats, on every append',
    ({ maxPerChat, appends, chats }) => {
      const store = new ObservedStore(path, maxPerChat, chats);
      const chatIds = Array.from({ length: chats }, (_, c) => String(-1000 - c));
      for (let i = 1; i <= appends; i++) {
        for (const chatId of chatIds) {
          expect(store.append(record(chatId, i, `m${i}`))).toBe(true);
          expect(store.entries(chatId).length).toBeLessThanOrEqual(maxPerChat);
        }
        expect(store.size()).toBeLessThanOrEqual(maxPerChat * chats);
        // The file is compacted as evictions accumulate: within a constant factor of the bound,
        // never proportional to how long the bridge has been running.
        expect(lineCount(path)).toBeLessThanOrEqual(2 * maxPerChat * chats + maxPerChat);
      }
      for (const chatId of chatIds) {
        const kept = store.entries(chatId);
        expect(kept.map((r) => r.message_id)).toEqual(
          Array.from({ length: Math.min(maxPerChat, appends) }, (_, k) => appends - kept.length + k + 1),
        );
        // Evicted ids leave the dedup set, so it is bounded by the retained records.
        expect(store.has(keyOf(record(chatId, 1, '')))).toBe(appends <= maxPerChat);
      }
      store.close();

      const reloaded = new ObservedStore(path, maxPerChat, chats);
      for (const chatId of chatIds) {
        expect(reloaded.entries(chatId).map((r) => r.content)).toEqual([
          ...Array.from({ length: Math.min(maxPerChat, appends) }, (_, k) => `m${appends - Math.min(maxPerChat, appends) + k + 1}`),
        ]);
      }
      reloaded.close();
    },
  );

  it('bounds the number of chats, and never refuses a chat the bridge serves', () => {
    const store = new ObservedStore(path, 10, 2);
    store.serve('-500');
    // Two unconfigured chats fill the cap; every further unconfigured chat is refused outright.
    expect(store.append(record('-1', 1, 'a'))).toBe(true);
    expect(store.append(record('-2', 1, 'b'))).toBe(true);
    for (let i = 3; i < 30; i++) expect(store.append(record(`-${i}`, 1, 'flood'))).toBe(false);
    // ...while a served chat is admitted past the cap, and stays retrievable.
    expect(store.append(record('-500', 1, 'mine'))).toBe(true);
    expect(store.entries('-500').map((r) => r.content)).toEqual(['mine']);
    expect(store.size()).toBe(3);
    expect(lineCount(path)).toBe(3);
    store.close();
  });

  it('bounds the chat count of a file written under a looser cap', () => {
    const lines = Array.from({ length: 30 }, (_, c) => JSON.stringify(record(`-${c}`, 1, `c${c}`)));
    writeFileSync(path, `${lines.join('\n')}\n`);

    const store = new ObservedStore(path, 10, 4);
    expect(store.size()).toBe(4);
    expect(lineCount(path)).toBe(4);
    store.close();
  });
});
