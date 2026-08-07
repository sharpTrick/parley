import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { keyOf, ObservedStore } from '../src/store.js';
import { captureStderr, lineCount, record, storePath } from './rig.js';

/** The composite ids a compaction carried out of the file — the persisted dedup memory. */
const persistedEvictedIds = (path: string): string[] => {
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('#evicted '));
  return line === undefined ? [] : (JSON.parse(line.slice('#evicted '.length)) as string[]);
};

let path: string;
beforeEach(() => {
  path = storePath();
});

/**
 * The observed-message store must repair a crash-torn tail on load and hold its retention
 * bounds at ALL times — a bound that only bites at load is no bound at all for a bridge that
 * never restarts.
 */
describe('telegram ObservedStore durability', () => {
  /**
   * WHAT the crash cut through. A tail that does not PARSE is repaired by the line loop's generic
   * `catch` whichever way the load-time torn-tail branch behaves, so a suite whose only torn
   * fixtures are unparseable grades that branch with nothing: deleting it left all 691 tests green.
   * A crash lands on a byte and not on a token, and the byte it most often lands on is the newline
   * — leaving a tail that is COMPLETE and parses, which only the torn branch can see. Such a file
   * loads its last line, is not rewritten, and the next append is glued straight onto it; the
   * following restart then loses that record AND whatever bookkeeping line the glue swallowed,
   * re-minting the identity and refusing every outstanding cursor.
   *
   * The last row is a file that was never torn at all: the repair must not fire on one, and a table
   * gone uniformly red is visible as such.
   */
  const TORN_TAILS = [
    { name: 'an unparseable record fragment', tail: '{"chat_id":"1","mess' },
    { name: 'a complete record', tail: JSON.stringify(record('1', 2, 'second')) },
    { name: 'a complete watermark the rest of the file agrees with', tail: '#seq 1 1' },
    { name: 'a complete served mark', tail: '#served ["1"]' },
    { name: 'nothing — the file already ends where a line ends', tail: '' },
  ];

  it.each(TORN_TAILS)(
    'repairs a crash-torn tail of $name so a later append survives a cold reload',
    ({ tail }) => {
      // Carrying an identity of its own, so that the row is graded on the REPAIR: a file with none
      // has one appended on load, and that append would supply the missing terminator for free.
      const head = `#epoch ${'a'.repeat(16)}\n#seq 1 1\n`;
      writeFileSync(path, `${head}${JSON.stringify(record('1', 1, 'first'))}\n${tail}`);

      const store = new ObservedStore(path);
      const loaded = store.entries('1').map((r) => r.content);
      // The next line is appended to whatever the load left behind, so it must leave a boundary.
      expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
      const recC = record('1', 3, 'third');
      expect(store.append(recC)).toBeDefined();
      store.close();

      const reloaded = new ObservedStore(path);
      // Nothing the store served in one process may go missing in the next, and the appended
      // record is neither glued onto the fragment nor lost with it.
      expect(reloaded.entries('1').map((r) => r.content)).toEqual([...loaded, 'third']);
      expect(loaded).toContain('first');
      expect(reloaded.has(keyOf(recC))).toBe(true);
      reloaded.close();
    },
  );

  /**
   * A line with no observation sequence is a damaged line, not an older format: the sequence IS the
   * cursor, so minting a fresh one for it files a record an agent's held cursor already sits above,
   * where nothing can ever reach it. Drop it like any other garbled line and let the redelivery in.
   *
   * The same holds for every OTHER field of the shape, and there it matters more rather than less,
   * because a wrong type there survives being loaded: a record whose `content` is not a string
   * reaches `buildMessage` and throws on every later `fetchRecent` for that chat, across restarts,
   * and the Bot API has no history endpoint that could refill the topic — this file is the only
   * copy. So the check runs over the whole record, and a file already carrying a bad line heals on
   * load instead of bricking a chat forever.
   */
  const DAMAGED = [
    { name: 'no observation sequence', damage: { seq: undefined } },
    { name: 'a fractional observation sequence', damage: { seq: 1.5 } },
    { name: 'a zero observation sequence', damage: { seq: 0 } },
    { name: 'a stringified observation sequence', damage: { seq: '2' } },
    { name: 'a numeric content', damage: { content: 12345 } },
    { name: 'an object content', damage: { content: { evil: 1 } } },
    { name: 'a null content', damage: { content: null } },
    { name: 'an object sender', damage: { sender: { evil: 1 } } },
    { name: 'a numeric sender', damage: { sender: 7 } },
    { name: 'a numeric chat_id', damage: { chat_id: 1 } },
    { name: 'a numeric ts', damage: { ts: 1_700_000_000 } },
    { name: 'a stringified message_id', damage: { message_id: '2' } },
    { name: 'no message_id', damage: { message_id: undefined } },
  ];

  it.each(DAMAGED)('drops a stored line carrying $name instead of loading it', ({ damage }) => {
    // A hand-written file arrives 0644, so the store tightens it and says so; that is its own
    // case's subject, not this one's.
    captureStderr();
    writeFileSync(
      path,
      `${[
        JSON.stringify(record('1', 1, 'first')),
        JSON.stringify({ ...record('1', 2, 'damaged'), ...damage }),
        JSON.stringify(record('1', 3, 'third')),
      ].join('\n')}\n`,
    );

    const store = new ObservedStore(path);
    expect(store.entries('1').map((r) => r.content)).toEqual(['first', 'third']);
    // Whatever survives a load is the shape every reader downstream is entitled to assume.
    for (const rec of store.entries('1')) {
      expect({ content: typeof rec.content, sender: typeof rec.sender, ts: typeof rec.ts }).toEqual({
        content: 'string',
        sender: 'string',
        ts: 'string',
      });
    }
    // Its id was never observed, so a redelivery of it is admitted — above every issued cursor,
    // because a dropped line never advances the sequence it failed to carry.
    expect(store.has(keyOf({ chat_id: '1', message_id: 2 }))).toBe(false);
    expect(store.append(record('1', 2, 'redelivered'))?.seq).toBe(4);
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
        const retained = Math.min(maxPerChat, appends);
        expect(reloaded.entries(chatId).map((r) => r.content)).toEqual(
          Array.from({ length: retained }, (_, k) => `m${appends - retained + k + 1}`),
        );
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
   * The axis the table above cannot reach: HOW MANY RECORDS the served chat holds. Every cell of it
   * appends one immediately after `serve()`, so the mark is always attached to a chat the store is
   * retaining — and the mark a rewrite must carry hardest is the one on a chat with NO records,
   * because a topic a seam call merely named has nothing else to declare it and `chat_map` cannot
   * stand in for it. Crossed with every way the file is REWRITTEN, since a rewrite is where a
   * derived mark list silently drops what it was not derived from.
   *
   * Graded through what the mark BUYS — the chat survives a flood at the cap in the next process —
   * rather than by reading the file, so the check outlives any change to how the mark is spelled.
   */
  const REWRITES = ['none', 'compaction', 'load-repair'] as const;
  const SERVED_MARK_CASES = [0, 1, 2].flatMap((records) =>
    REWRITES.map((rewrite) => ({ records, rewrite })),
  );

  it.each(SERVED_MARK_CASES)(
    'a chat served with $records records of its own stays protected across a $rewrite rewrite',
    ({ records, rewrite }) => {
      const maxChats = 2;
      const mine = '-700';
      const writer = new ObservedStore(path, 4, maxChats);
      writer.serve(mine);
      for (let i = 1; i <= records; i++) {
        expect(writer.append(record(mine, i, `mine-${i}`))).toBeDefined();
      }
      // Evictions in a chat nobody serves are what arm the store's amortized rewrite.
      if (rewrite === 'compaction') {
        for (let i = 1; i <= 40; i++) writer.append(record('-1', i, `filler-${i}`));
      }
      writer.close();
      if (rewrite === 'load-repair') writeFileSync(path, `${readFileSync(path, 'utf8')}{"torn`);

      // Reload declaring NOTHING served: the FILE is the only thing left that can protect it.
      let reloaded = new ObservedStore(path, 4, maxChats);
      if (rewrite === 'load-repair') {
        // The repair rewrote the file — the mark has to survive THAT, not merely one read of it.
        reloaded.close();
        reloaded = new ObservedStore(path, 4, maxChats);
      }
      expect(reloaded.append(record(mine, 99, 'after the restart'))).toBeDefined();
      for (let i = 0; i < maxChats + 3; i++) {
        reloaded.append(record(`-80${i}`, 1, `flood-${i}`));
      }

      const kept = reloaded.entries(mine).map((r) => r.content);
      expect(kept).toContain('after the restart');
      for (let i = 1; i <= records; i++) expect(kept).toContain(`mine-${i}`);
      reloaded.close();
    },
  );

  /**
   * The other edge of the same bound: the mark list is what a flood of SEAM-NAMED topics grows, and
   * a list carried without one grows with every id the store has ever served, forever, across every
   * later load that reads it back. Bounded, and bounded on the marks rather than on the records, so
   * that the recordless mark above is not the thing the bound is paid for with.
   */
  it('bounds the served marks a compaction carries however many chats were named', () => {
    const writer = new ObservedStore(path, 1, 2);
    for (let i = 0; i < 4_000; i++) writer.serve(`-9${i}`);
    for (let i = 1; i <= 40; i++) writer.append(record('-1', i, `filler-${i}`));
    writer.close();

    const marks = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('#served '))
      .flatMap((l) => JSON.parse(l.slice('#served '.length)) as string[]);
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.length).toBeLessThanOrEqual(2_000);
    // The newest-named survive: the oldest is what a bound may drop, never the most recent one.
    expect(marks).toContain('-93999');
  });

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

    const other = new ObservedStore(join(dirname(path), 'other.jsonl'), 2, 10);
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
    captureStderr();
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
   * The identity is minted afresh only when the file did not load WHOLE, and a record leaving
   * through retention or the chat cap is a record leaving on purpose. Every cell puts the store's
   * HIGHEST sequence in the records that go, which is the shape a loss detector reading the record
   * lines alone cannot tell from corruption — and it is graded across TWO reloads, because the
   * first is where the store rewrites what it now holds and the second is where a detector that
   * wrote the wrong high-water down fires on its own output. A store that churned its identity here
   * would refuse every cursor an agent holds on the first reload of any busy bridge.
   */
  const LEGITIMATE_EVICTIONS = [
    // Per-chat eviction takes the OLDEST of a chat, so the store's newest record always survives it:
    // this row grades the plain claim that eviction is not loss.
    { name: 'the per-chat bound, over several chats', maxPerChat: 2, maxChats: 10, chats: 3, each: 5 },
    // The chat cap can take the newest record along with the chat holding it, which is the one shape
    // where what a file retains sits BELOW what it has issued — and the only one that can tell a
    // store persisting both watermarks from one persisting the high-water twice.
    { name: 'the chat cap, taking the most recently active chat', maxPerChat: 10, maxChats: 1, chats: 4, each: 1 },
  ];

  it.each(LEGITIMATE_EVICTIONS)(
    'keeps its identity when $name evicts the newest record it holds',
    ({ maxPerChat, maxChats, chats, each }) => {
      const stderr = captureStderr();
      const SERVED = '-70';
      const chatIds = Array.from({ length: chats }, (_, c) => String(-1000 - c));
      const writer = new ObservedStore(path, 100, 100, [SERVED]);
      const identity = writer.epoch();
      writer.append(record(SERVED, 1, 'mine'));
      let mid = 1;
      for (let i = 0; i < each; i++) {
        for (const chatId of chatIds) writer.append(record(chatId, ++mid, `m${mid}`));
      }
      const issued = writer.highWater();
      writer.close();

      for (const pass of [1, 2]) {
        const reloaded = new ObservedStore(path, maxPerChat, maxChats, [SERVED]);
        expect({ pass, epoch: reloaded.epoch() }).toEqual({ pass, epoch: identity });
        // And the sequence space never regresses: a record appended after the eviction still sorts
        // above every cursor the writer handed out.
        expect(reloaded.highWater()).toBeGreaterThanOrEqual(issued);
        reloaded.close();
      }
      expect(stderr.join('')).not.toMatch(/did not load whole/);
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
