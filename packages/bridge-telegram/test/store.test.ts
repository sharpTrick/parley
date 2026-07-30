import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureStderr } from './rig.js';
import { keyOf, ObservedStore, type StoredRecord } from '../src/store.js';

const record = (chatId: string, messageId: number, content: string, seq = messageId): StoredRecord => ({
  chat_id: chatId,
  message_id: messageId,
  seq,
  sender: 's',
  content,
  ts: new Date().toISOString(),
});

/** Record lines on disk — the dedup memory a compaction persists is not a record. */
const lineCount = (path: string): number =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#')).length;

const modeOf = (target: string): number => statSync(target).mode & 0o777;

/** The composite ids a compaction carried out of the file — the persisted dedup memory. */
const persistedEvictedIds = (path: string): string[] => {
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('#evicted '));
  return line === undefined ? [] : (JSON.parse(line.slice('#evicted '.length)) as string[]);
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

  /**
   * A line with no observation sequence is a damaged line, not an older format: the sequence IS the
   * cursor, so minting a fresh one for it files a record an agent's held cursor already sits above,
   * where nothing can ever reach it. Drop it like any other garbled line and let the redelivery in.
   */
  it('drops a stored line carrying no observation sequence instead of minting one', () => {
    const seqless = {
      chat_id: '1',
      message_id: 2,
      sender: 's',
      content: 'seqless',
      ts: '2024-01-01T00:00:00.000Z',
    };
    writeFileSync(
      path,
      `${[
        JSON.stringify(record('1', 1, 'first')),
        JSON.stringify(seqless),
        JSON.stringify(record('1', 3, 'third')),
      ].join('\n')}\n`,
    );

    const store = new ObservedStore(path);
    expect(store.entries('1').map((r) => r.content)).toEqual(['first', 'third']);
    // Its id was never observed, so a redelivery of it is admitted — above every issued cursor.
    expect(store.has(keyOf(seqless))).toBe(false);
    expect(store.append(seqless)?.seq).toBe(4);
    expect(store.entries('1').map((r) => r.seq)).toEqual([1, 3, 4]);
    store.close();
  });

  it('bounds a pre-written file to newest-N, compacts it, and frees the fd on close', () => {
    const N = 5;
    const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify(record('1', i + 1, `m${i + 1}`)));
    writeFileSync(path, `${lines.join('\n')}\n`);

    const store = new ObservedStore(path, N);
    expect(store.entries('1').map((r) => r.message_id)).toEqual([16, 17, 18, 19, 20]);
    // Retention bounds what is RETAINED, never what is refusable: the evicted record leaves the
    // queryable window and still cannot be re-admitted.
    expect(store.size()).toBe(N);
    expect(store.has(keyOf(record('1', 1, '')))).toBe(true);
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
        // Dedup outlives eviction: the oldest id is refused whether or not it is still retained.
        expect(store.append(record(chatId, 1, 'replay'))).toBeUndefined();
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

  /**
   * The once-only guarantee (DESIGN §6, and the README's "dedup across `getUpdates` backlog
   * replays"): the SECOND append of a composite id writes nothing and returns undefined, while
   * a record differing in either half of the composite is a different message and is admitted.
   * Telegram's `message_id` is unique only per chat, so both halves have to be in the key.
   */
  const DEDUP_CASES = [
    { name: 'the same chat and message_id', chat: '-1', messageId: 1, admitted: false },
    { name: 'the same message_id in another chat', chat: '-2', messageId: 1, admitted: true },
    { name: 'another message_id in the same chat', chat: '-1', messageId: 2, admitted: true },
  ];

  it.each(DEDUP_CASES)('a second append of $name is admitted: $admitted', ({ chat, messageId, admitted }) => {
    const store = new ObservedStore(path, 10, 10);
    const first = store.append(record('-1', 1, 'once'));
    expect(first).toBeDefined();

    const second = store.append(record(chat, messageId, 'again'));
    expect(second === undefined).toBe(!admitted);
    expect(store.size()).toBe(admitted ? 2 : 1);
    expect(lineCount(path)).toBe(admitted ? 2 : 1);
    // A refused append leaves the first record — and its sequence — untouched.
    expect(store.entries('-1').map((r) => [r.seq, r.content])).toEqual(
      admitted && chat === '-1' ? [[1, 'once'], [2, 'again']] : [[1, 'once']],
    );
    store.close();

    // The dedup set is rebuilt from the file, so the refusal survives a cold reload.
    const reloaded = new ObservedStore(path, 10, 10);
    expect(reloaded.append(record('-1', 1, 'again'))).toBeUndefined();
    expect(reloaded.size()).toBe(admitted ? 2 : 1);
    reloaded.close();
  });

  /**
   * Retention and dedup are two different horizons, and the once-only guarantee is the dedup one.
   * Telegram re-serves an unacknowledged `getUpdates` batch, so a record retention has already
   * evicted can still be redelivered — and re-admitting it hands the same `backendMsgId` out twice
   * at two different cursors, the second one ABOVE a cursor the agent already holds, which no
   * bounded in-memory dedup downstream can absorb.
   *
   * The axis that decides it is how much of the eviction the file still shows: while the evicted
   * LINES are there, a reload rebuilds the memory by trimming them again; once a compaction has
   * carried them out, only the persisted memory can answer. Every cell drives the eviction, the
   * replay, and then a genuinely new message — refusing everything is not the fix.
   */
  const REPLAY_CELLS = [
    { maxPerChat: 1, newer: 1 },
    { maxPerChat: 2, newer: 2 },
    { maxPerChat: 2, newer: 6 },
    { maxPerChat: 3, newer: 12 },
    { maxPerChat: 5, newer: 40 },
  ].flatMap((cell) => [
    { ...cell, reload: false },
    { ...cell, reload: true },
  ]);

  it.each(REPLAY_CELLS)(
    'a record evicted under newest-$maxPerChat is still refused after $newer newer ones (reload: $reload)',
    ({ maxPerChat, newer, reload }) => {
      const CHAT = '-1001111000';
      const first = record(CHAT, 1, 'one');
      let store = new ObservedStore(path, maxPerChat, 10);
      expect(store.append(first)).toBeDefined();
      for (let i = 0; i < newer; i++) {
        expect(store.append(record(CHAT, i + 2, `m${i + 2}`))).toBeDefined();
      }
      expect(store.entries(CHAT).some((r) => r.message_id === 1)).toBe(false);
      if (reload) {
        store.close();
        store = new ObservedStore(path, maxPerChat, 10);
      }

      const retained = store.size();
      const lines = lineCount(path);
      const highWater = store.highWater();
      expect(store.append(first)).toBeUndefined();
      expect(store.has(keyOf(first))).toBe(true);
      // Refused SILENTLY: nothing stored, no line written, and no sequence burnt — a burnt
      // sequence would leave a hole a later cursor comparison reads as a lost message.
      expect(store.size()).toBe(retained);
      expect(lineCount(path)).toBe(lines);
      expect(store.highWater()).toBe(highWater);
      expect(store.entries(CHAT).some((r) => r.message_id === 1)).toBe(false);

      // A genuinely new message is still admitted, above every cursor already issued.
      expect(store.append(record(CHAT, 9999, 'new'))?.seq).toBe(highWater + 1);
      store.close();
    },
  );

  /**
   * The persisted half of that memory, pinned directly: a compaction is where the evicted lines
   * leave the file, so it has to carry their ids out with them. Without the line on disk the
   * table above passes on its non-compacting cells alone.
   */
  it('carries the evicted ids out of the file when a compaction drops their lines', () => {
    const CHAT = '-1001111001';
    const store = new ObservedStore(path, 2, 10);
    for (let i = 1; i <= 8; i++) expect(store.append(record(CHAT, i, `m${i}`))).toBeDefined();
    store.close();

    expect(lineCount(path)).toBe(2);
    expect(persistedEvictedIds(path)).toEqual(
      Array.from({ length: 6 }, (_, i) => `${CHAT}:${i + 1}`),
    );
    // The ids are on disk AND honoured on load, whichever record the replay names.
    const reloaded = new ObservedStore(path, 2, 10);
    for (let i = 1; i <= 8; i++) expect(reloaded.append(record(CHAT, i, `m${i}`))).toBeUndefined();
    expect(reloaded.entries(CHAT).map((r) => r.content)).toEqual(['m7', 'm8']);
    reloaded.close();
  });

  /**
   * The ordering and dedup rules over a GENERATED history rather than the shapes someone thought to
   * write down: random chats, random message_ids, reloads at random points, with retention and
   * compaction biting throughout. These are the invariants that make an in-order insert unnecessary
   * — a chat's records only ever arrive ascending — so they are what has to hold if the append path
   * is ever simplified again, and they fail on a whole class of ordering defects rather than on one
   * input. Every run is a fixed seed, so a failure is reproducible.
   */
  it.each([1, 2, 3])('holds its ordering and dedup invariants over generated history %i', (run) => {
    let seed = 7 + run * 977;
    const rand = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const chats = ['-11', '-12', '-13'];
    const admitted = new Map<string, number>();
    let store = new ObservedStore(path, 4, chats.length);

    for (let i = 0; i < 150; i++) {
      const chatId = chats[rand(chats.length)] as string;
      const messageId = 1 + rand(20);
      const rec = record(chatId, messageId, `m-${chatId}-${messageId}`);
      const highWater = store.highWater();
      const stored = store.append(rec);

      if (stored === undefined) {
        // The only reason to refuse here is that the id was already observed — and a refusal never
        // burns a sequence, which would leave a hole a later cursor compare reads as a lost message.
        expect(admitted.has(keyOf(rec))).toBe(true);
        expect(store.highWater()).toBe(highWater);
      } else {
        expect(admitted.has(keyOf(rec))).toBe(false);
        expect(stored.seq).toBe(highWater + 1);
        admitted.set(keyOf(rec), stored.seq);
      }
      for (const id of chats) {
        const seqs = store.entries(id).map((r) => r.seq);
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        expect(new Set(seqs).size).toBe(seqs.length);
        expect(seqs.length).toBeLessThanOrEqual(4);
      }
      // Reload at a random point: a cursor an agent holds outlives the process that issued it, so
      // the sequence space may never regress across one.
      if (rand(9) === 0) {
        const highest = store.highWater();
        store.close();
        store = new ObservedStore(path, 4, chats.length);
        expect(store.highWater()).toBe(highest);
      }
    }

    // Everything ever admitted is still refused, and every retained record is one that was admitted.
    for (const [id, seq] of admitted) {
      expect(store.has(id)).toBe(true);
      expect(seq).toBeLessThanOrEqual(store.highWater());
    }
    for (const id of chats) {
      for (const rec of store.entries(id)) expect(admitted.get(keyOf(rec))).toBe(rec.seq);
    }
    store.close();
  });

  it('rejects a non-positive or fractional retention bound instead of substituting the default', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ObservedStore(path, bad)).toThrow(/maxPerChat must be a positive integer/);
      expect(() => new ObservedStore(path, 10, bad)).toThrow(/maxChats must be a positive integer/);
    }
  });

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
   * `serve()` is how a topic named only by a SEAM CALL earns its protection — `chat_map` is
   * re-declared on every construction, that is not. So the mark has to outlive the process: a
   * protection rebuilt from the constructor argument alone evaporates at the next load, where the
   * chat cap runs before any seam call could name a topic and evicts the operator's own history —
   * which the Bot API has no endpoint to backfill.
   *
   * Every cell serves MORE chats than the cap admits and interleaves the flood through them, so a
   * served chat is the oldest, the newest, and somewhere in between — the load-time cap would take
   * the oldest first if the mark were gone. The reload passes NO served argument at all: what is
   * under test is what the FILE carries, which is the half `chat_map` cannot stand in for.
   */
  const SERVED_PERSISTENCE_CASES = [
    { served: 3, flood: 5, maxChats: 2 },
    { served: 2, flood: 0, maxChats: 1 },
    { served: 4, flood: 6, maxChats: 3 },
    { served: 2, flood: 3, maxChats: 1 },
    { served: 5, flood: 2, maxChats: 4 },
  ];

  it.each(SERVED_PERSISTENCE_CASES)(
    '$served chats served at runtime keep their records across a reload under a cap of $maxChats',
    ({ served, flood, maxChats }) => {
      const servedIds = Array.from({ length: served }, (_, i) => `-70${i}`);
      const floodIds = Array.from({ length: flood }, (_, i) => `-91${i}`);
      const writer = new ObservedStore(path, 10, maxChats);
      let mid = 0;
      for (let i = 0; i < Math.max(served, flood); i++) {
        const servedId = servedIds[i];
        if (servedId !== undefined) {
          writer.serve(servedId);
          expect(writer.append(record(servedId, ++mid, `m-${servedId}`))).toBeDefined();
        }
        const floodId = floodIds[i];
        // A flood append may be admitted, may displace another flood chat, or may be refused
        // outright once every retained chat is served — all three are the cap doing its job.
        if (floodId !== undefined) writer.append(record(floodId, ++mid, `f-${floodId}`));
      }
      writer.close();

      const reloaded = new ObservedStore(path, 10, maxChats);
      for (const id of servedIds) {
        expect(reloaded.entries(id).map((r) => r.content)).toEqual([`m-${id}`]);
      }
      // The cap still bounds the chats nobody serves — protection is not a licence to keep
      // everything, and a store over the cap on served chats alone has no room left for them.
      const keptFlood = floodIds.filter((id) => reloaded.entries(id).length > 0);
      expect(keptFlood.length).toBe(Math.max(0, maxChats - served));
      // And it survives a SECOND reload: the mark is rewritten, not merely read once.
      reloaded.close();
      const again = new ObservedStore(path, 10, maxChats);
      for (const id of servedIds) {
        expect(again.entries(id).map((r) => r.content)).toEqual([`m-${id}`]);
      }
      again.close();
    },
  );

  /**
   * The identity of the store FILE, which is what makes a cursor from a store this one did not
   * inherit refusable however far this store's own sequence has since climbed. It must be stable
   * across reloads and across the compaction that rewrites every other line, and two files must
   * never share one.
   */
  it('keeps one stable identity per store file, and mints a distinct one per file', () => {
    const store = new ObservedStore(path, 2, 10);
    const identity = store.epoch();
    expect(identity).toMatch(/^[0-9a-f]{16}$/);
    for (let i = 1; i <= 8; i++) expect(store.append(record('-1', i, `m${i}`))).toBeDefined();
    // Compaction rewrites the whole file; the identity is not a line it may drop.
    expect(store.epoch()).toBe(identity);
    store.close();

    const reloaded = new ObservedStore(path, 2, 10);
    expect(reloaded.epoch()).toBe(identity);
    reloaded.close();

    const other = new ObservedStore(join(dir, 'other.jsonl'), 2, 10);
    expect(other.epoch()).not.toBe(identity);
    other.close();
  });

  /**
   * Every way the identity line itself can be lost or damaged. A store that adopted a garbled one
   * would answer a stale cursor out of a sequence space that cursor was never minted against.
   */
  const IDENTITY_DAMAGE = [
    { name: 'the line removed', line: undefined },
    { name: 'a truncated identity', line: '#epoch abc' },
    { name: 'an over-long identity', line: '#epoch 00112233445566778899' },
    { name: 'a non-hex identity', line: '#epoch zzzzzzzzzzzzzzzz' },
    { name: 'an empty identity', line: '#epoch ' },
  ];

  it.each(IDENTITY_DAMAGE)('mints a fresh identity when the file carries $name', ({ line }) => {
    const store = new ObservedStore(path, 10, 10);
    const identity = store.epoch();
    expect(store.append(record('-1', 1, 'a'))).toBeDefined();
    store.close();

    const kept = readFileSync(path, 'utf8')
      .trimEnd()
      .split('\n')
      .filter((l) => !l.startsWith('#epoch'));
    writeFileSync(path, `${[...(line === undefined ? [] : [line]), ...kept].join('\n')}\n`);

    const reloaded = new ObservedStore(path, 10, 10);
    expect(reloaded.epoch()).toMatch(/^[0-9a-f]{16}$/);
    expect(reloaded.epoch()).not.toBe(identity);
    // The records themselves are untouched — only the cursors minted against them are invalidated.
    expect(reloaded.entries('-1').map((r) => r.content)).toEqual(['a']);
    reloaded.close();
  });

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

/**
 * This file is the full plaintext of every message the bridge has observed — sender handles, chat
 * ids and bodies, in every chat the bot is in — living in the same state directory where core keeps
 * mere cursors at 0600 under a 0700 directory. Every path that CREATES or REPLACES it has to hold
 * that, not just the first one: an `openSync` mode applies only to a file it creates, and a
 * `renameSync` installs the temp file's mode over the target, so a store tightened on creation is
 * re-widened by the next compaction unless the temp file is tight too.
 */
describe('telegram ObservedStore file permissions', () => {
  interface Cell {
    name: string;
    /** Runs before the store is opened — an upgrade onto state an earlier version left behind. */
    prepare?: (path: string) => void;
    /** Append enough to force a compaction, so the file under test is a rewrite's output. */
    compact?: boolean;
    /** What must be unreadable by group and other. */
    targets: (path: string) => string[];
    /** The one path the store must NAME on stderr as tightened; nothing else may be reported. */
    tightens?: (path: string) => string;
  }

  const loose = (target: string): void => {
    chmodSync(target, 0o666);
    expect(modeOf(target) & 0o077).not.toBe(0);
  };

  const CELLS: Cell[] = [
    {
      name: 'the store file it creates',
      targets: (p) => [p],
    },
    {
      name: 'every directory it creates on the way',
      targets: (p) => [dirname(p), dirname(dirname(p))],
    },
    {
      name: 'the store file a compaction replaces',
      compact: true,
      targets: (p) => [p],
    },
    {
      // A leftover temp file is REPLACED, never written through: it is unlinked and recreated
      // exclusively, so its mode never reaches the store and there is nothing to tighten.
      name: 'the store file a compaction replaces over a leftover world-readable temp file',
      prepare: (p) => {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(`${p}.tmp`, 'junk from a crashed compaction\n');
        loose(`${p}.tmp`);
      },
      compact: true,
      targets: (p) => [p],
    },
    {
      name: 'a pre-existing world-readable store file',
      prepare: (p) => {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, `${JSON.stringify(record('-1', 1, 'from an older version'))}\n`);
        loose(p);
      },
      targets: (p) => [p],
      tightens: (p) => p,
    },
  ];

  it.each(CELLS)('keeps $name owner-only', ({ prepare, compact, targets, tightens }) => {
    // Nested, so the directories under test are ones the store had to create itself.
    const nested = join(dir, 'nested', 'deep', 'store.jsonl');
    prepare?.(nested);
    const stderr = captureStderr();

    const store = new ObservedStore(nested, 2, 10);
    for (let i = 1; i <= (compact === true ? 8 : 1); i++) {
      store.append(record('-1', 100 + i, `m${i}`));
    }
    store.close();

    for (const target of targets(nested)) expect(modeOf(target) & 0o077).toBe(0);
    // A tightening is never silent, and a store that was already tight says nothing at all.
    const named = tightens?.(nested);
    if (named === undefined) expect(stderr).toEqual([]);
    else expect(stderr.join('')).toContain(`tightened ${named}`);
  });

  /**
   * `<store_path>.tmp` is a predictable name in a directory the store does not own — `store_path`
   * can be anywhere the operator put it, and `mkdirSync(…, {mode: 0o700})` applies only to
   * directories the store itself created. A compaction renames whatever that name resolves to over
   * the store, so anything already there that is not a regular file this call created would let a
   * local attacker redirect the full plaintext of every observed message (and have its mode
   * narrowed for them). Every kind of squatted temp path is graded on the same two outcomes.
   */
  const SQUATTED = [
    { name: 'a world-readable regular file', kind: 'file' as const, compacts: true },
    { name: 'a symlink to a file outside the store directory', kind: 'symlink-file' as const, compacts: false },
    { name: 'a symlink to a directory outside the store directory', kind: 'symlink-dir' as const, compacts: false },
    { name: 'a dangling symlink', kind: 'symlink-dangling' as const, compacts: false },
    { name: 'a directory', kind: 'dir' as const, compacts: false },
    { name: 'a FIFO', kind: 'fifo' as const, compacts: false },
  ];

  it.each(SQUATTED)('refuses to compact through $name, leaving what it points at alone', ({ kind, compacts }) => {
    const outside = mkdtempSync(join(tmpdir(), 'parley-tg-victim-'));
    const victimFile = join(outside, 'victim.txt');
    const victimDir = join(outside, 'victim-dir');
    writeFileSync(victimFile, 'private\n');
    chmodSync(victimFile, 0o644);
    mkdirSync(victimDir);
    const store = join(dir, 'squat', 'store.jsonl');
    mkdirSync(dirname(store), { recursive: true });
    const tmp = `${store}.tmp`;
    if (kind === 'file') writeFileSync(tmp, 'junk\n');
    if (kind === 'symlink-file') symlinkSync(victimFile, tmp);
    if (kind === 'symlink-dir') symlinkSync(victimDir, tmp);
    if (kind === 'symlink-dangling') symlinkSync(join(outside, 'not-there'), tmp);
    if (kind === 'dir') mkdirSync(tmp);
    if (kind === 'fifo') execFileSync('mkfifo', [tmp]);

    const stderr = captureStderr();
    const observed = new ObservedStore(store, 2, 10);
    // Eight appends under newest-2 drive several compactions.
    for (let i = 1; i <= 8; i++) expect(observed.append(record('-1', i, `secret-${i}`))).toBeDefined();
    observed.close();

    // Nothing outside the store's own directory was touched, whatever the temp path pointed at.
    expect(readFileSync(victimFile, 'utf8')).toBe('private\n');
    expect(modeOf(victimFile)).toBe(0o644);
    expect(readdirSync(victimDir)).toEqual([]);
    if (compacts) {
      expect(stderr.join('')).not.toMatch(/refusing to compact/);
      expect(lineCount(store)).toBeLessThanOrEqual(4);
      // The squatted file was replaced, not written through: the rename consumed a fresh one.
      expect(existsSync(tmp)).toBe(false);
      expect(readFileSync(store, 'utf8')).toContain('secret-8');
    } else {
      // Loud, and the store keeps every record rather than trading durability for a compaction —
      // on the load path too, where a throw is the only way to say it.
      expect(stderr.join('')).toMatch(/refusing to compact/);
      expect(stderr.join('')).toContain(tmp);
      expect(lineCount(store)).toBe(8);
      expect(() => new ObservedStore(store, 2, 10)).toThrow(/refusing to compact/);
      rmSync(tmp, { recursive: true, force: true });
    }
    // Every record survived the obstruction, and the store compacts again once it clears.
    const reopened = new ObservedStore(store, 2, 10);
    expect(reopened.entries('-1').map((r) => r.content)).toEqual(['secret-7', 'secret-8']);
    reopened.close();
    expect(lineCount(store)).toBe(2);
    rmSync(outside, { recursive: true, force: true });
  });
});
