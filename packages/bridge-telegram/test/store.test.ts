import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyOf, ObservedStore, type StoredRecord } from '../src/store.js';

const record = (chatId: string, messageId: number, content: string, seq = messageId): StoredRecord => ({
  chat_id: chatId,
  message_id: messageId,
  seq,
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
 * The observed-message store must repair a crash-torn tail on load and hold its retention
 * bounds at ALL times — a bound that only bites at load is no bound at all for a bridge that
 * never restarts.
 */
describe('telegram ObservedStore durability', () => {
  it('repairs a crash-torn tail so a later append survives a cold reload', () => {
    // One complete record, then a crash-torn fragment of a second (NO trailing newline).
    writeFileSync(path, `${JSON.stringify(record('1', 1, 'first'))}\n{"chat_id":"1","mess`);

    const store = new ObservedStore(path);
    const recC = record('1', 3, 'third');
    expect(store.append(recC)).toBeDefined();
    store.close();

    const reloaded = new ObservedStore(path);
    // The complete record survives, the fragment is dropped, and the append is NOT glued/lost.
    expect(reloaded.entries('1').map((r) => r.content)).toEqual(['first', 'third']);
    expect(reloaded.has(keyOf(recC))).toBe(true);
    reloaded.close();
  });

  it('bounds a pre-written file to newest-N, compacts it, and frees the fd on close', () => {
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
    expect(store.append(record('1', 99, 'x'))).toBeUndefined();
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
          expect(store.append(record(chatId, i, `m${i}`))).toBeDefined();
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

  it('bounds the number of chats, and admits a chat the bridge serves past the cap', () => {
    const store = new ObservedStore(path, 10, 2);
    store.serve('-500');
    // Two unconfigured chats fill the cap; further unconfigured chats displace each other.
    expect(store.append(record('-1', 1, 'a'))).toBeDefined();
    expect(store.append(record('-2', 1, 'b'))).toBeDefined();
    for (let i = 3; i < 30; i++) expect(store.append(record(`-${i}`, 1, 'flood'))).toBeDefined();
    expect(store.size()).toBe(2);
    // ...while a served chat is admitted past the cap, and stays retrievable.
    expect(store.append(record('-500', 1, 'mine'))).toBeDefined();
    expect(store.entries('-500').map((r) => r.content)).toEqual(['mine']);
    expect(store.size()).toBe(3);
    store.close();
  });

  it('displaces the least recently active unserved chat, never a served one', () => {
    const store = new ObservedStore(path, 10, 3, ['-500']);
    expect(store.append(record('-1', 1, 'a'))).toBeDefined();
    expect(store.append(record('-2', 1, 'b'))).toBeDefined();
    expect(store.append(record('-500', 1, 'mine'))).toBeDefined();
    // -2 becomes the more recently active unserved chat, so -1 is the one that must go.
    expect(store.append(record('-2', 2, 'b2'))).toBeDefined();
    expect(store.append(record('-3', 1, 'c'))).toBeDefined();

    expect(store.entries('-1')).toEqual([]);
    expect(store.entries('-2').map((r) => r.content)).toEqual(['b', 'b2']);
    expect(store.entries('-3').map((r) => r.content)).toEqual(['c']);
    expect(store.entries('-500').map((r) => r.content)).toEqual(['mine']);
    store.close();
  });

  it('refuses a new chat only when every retained chat is served', () => {
    const store = new ObservedStore(path, 10, 2, ['-500', '-600']);
    expect(store.append(record('-500', 1, 'a'))).toBeDefined();
    expect(store.append(record('-600', 1, 'b'))).toBeDefined();
    expect(store.append(record('-900', 1, 'flood'))).toBeUndefined();
    expect(store.entries('-500').map((r) => r.content)).toEqual(['a']);
    expect(store.entries('-600').map((r) => r.content)).toEqual(['b']);
    store.close();
  });

  /**
   * The load path is where the operator's own chat is most exposed: it runs before any seam call
   * could name a topic, and the Bot API has no history endpoint, so a served chat dropped here
   * is history nothing can ever rebuild. Every combination where the chats on disk exceed the
   * cap must lose only UNSERVED chats, oldest-active first.
   */
  const CAP_CASES = [
    { served: 1, flood: 3, maxChats: 2 },
    { served: 2, flood: 1, maxChats: 2 },
    { served: 2, flood: 8, maxChats: 3 },
    { served: 3, flood: 5, maxChats: 4 },
    { served: 0, flood: 6, maxChats: 2 },
    { served: 4, flood: 4, maxChats: 1 },
  ];

  it.each(CAP_CASES)(
    'reloading $served served + $flood unserved chats under a cap of $maxChats keeps every served chat',
    ({ served, flood, maxChats }) => {
      const servedIds = Array.from({ length: served }, (_, i) => `-10${i}`);
      const floodIds = Array.from({ length: flood }, (_, i) => `-90${i}`);
      // Interleaved, so a served chat is the oldest, the newest, and somewhere in between.
      const order: string[] = [];
      for (let i = 0; i < Math.max(served, flood); i++) {
        if (i < served) order.push(servedIds[i] as string);
        if (i < flood) order.push(floodIds[i] as string);
      }
      const writer = new ObservedStore(path, 10, order.length, servedIds);
      for (const [i, id] of order.entries()) {
        expect(writer.append(record(id, i + 1, `m-${id}`))).toBeDefined();
      }
      writer.close();

      const reloaded = new ObservedStore(path, 10, maxChats, servedIds);
      for (const id of servedIds) {
        expect(reloaded.entries(id).map((r) => r.content)).toEqual([`m-${id}`]);
      }
      const keptFlood = Math.max(0, Math.min(flood, maxChats - served));
      expect(reloaded.size()).toBe(served + keptFlood);
      // The unserved survivors are the most recently active ones.
      for (const id of floodIds.slice(0, flood - keptFlood)) expect(reloaded.entries(id)).toEqual([]);
      for (const id of floodIds.slice(flood - keptFlood)) expect(reloaded.entries(id)).toHaveLength(1);
      expect(lineCount(path)).toBe(served + keptFlood);
      reloaded.close();
    },
  );

  /**
   * The cursor is the store's own observation sequence, not Telegram's `message_id`: it must be
   * strictly increasing in the order records were APPENDED even when the ids they carry are not,
   * and it must survive a reload — a cursor an agent holds outlives the process that issued it.
   */
  it('stamps a monotonic observation sequence regardless of message_id order, and persists it', () => {
    const store = new ObservedStore(path, 10, 10);
    const mids = [7, 3, 9, 1, 8];
    const seqs = mids.map((mid) => store.append(record('-1', mid, `m${mid}`))?.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(new Set(seqs).size).toBe(mids.length);
    expect(store.entries('-1').map((r) => r.message_id)).toEqual(mids);
    expect(store.maxSeq('-1')).toBe(seqs.at(-1));
    store.close();

    const reloaded = new ObservedStore(path, 10, 10);
    expect(reloaded.entries('-1').map((r) => r.seq)).toEqual(seqs);
    // A record observed after the reload still sorts above every cursor already handed out.
    const next = reloaded.append(record('-1', 2, 'later'));
    expect(next?.seq).toBeGreaterThan(seqs.at(-1) as number);
    expect(reloaded.entries('-1').at(-1)?.content).toBe('later');
    reloaded.close();
  });
});
