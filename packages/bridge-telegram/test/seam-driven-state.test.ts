import { readFileSync, statSync } from 'node:fs';
import { asTopic, asHandle, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import type { TelegramPlugin } from '../src/index.js';
import { ObservedStore, SERVED_ID_MEMORY } from '../src/store.js';
import type { FakeTelegram } from './fake-telegram.js';
import { connectTo, contentsOf, lineCount, record, SENDER, startFake, storePath } from './rig.js';

/**
 * How many of `chats` `store` holds past a chat cap of one. A served chat is admitted past the cap
 * and never evicted to make room, so this counts the cap EXEMPTIONS the store is carrying —
 * measured through its own admission path rather than off a private field.
 *
 * Probing with `append` and never with a topic, so that the measurement cannot create the very
 * exemption it is counting. It leaves records behind, so ask it last.
 */
const exemptionsHeldBy = (store: ObservedStore, chats: readonly string[]): number => {
  for (const chat of chats) store.append(record(chat, 1, 'probe'));
  const kept = chats.filter((chat) => store.entries(chat).length > 0).length;
  // One unserved chat fits under the cap of one; everything above that was exempt.
  return Math.max(0, kept - 1);
};

/** The same count for the exemptions a store FILE carries into the next process. */
const exemptionsIn = (path: string, chats: readonly string[]): number => {
  const store = new ObservedStore(path, 1, 1);
  const held = exemptionsHeldBy(store, chats);
  store.close();
  return held;
};

const servedLines = (path: string): number =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('#served ')).length;

/**
 * A topic is chosen by the CALLER: core's allowlist admits `post_topics` regex patterns, so a
 * supported configuration hands this plugin a topic space that is model-chosen rather than
 * operator-sized. Every seam method resolves its topic, and resolving marks the chat as served —
 * a durable append to the observed-message store and a permanent exemption from
 * `observed_max_chats`. So a plain read is a write, and 500 of them used to leave 500 bookkeeping
 * lines, zero records and 500 chats the cap could no longer evict.
 *
 * The rows sweep each seam method over a topic space far wider than any bound, and assert what has
 * to hold whatever the caller names: the durable state stops growing, the file that carries it is
 * reclaimed, and the chats the OPERATOR declared keep the protection they configured.
 */
describe('telegram seam calls on a caller-chosen topic space', () => {
  const SWEEP = 2_500;
  const DECLARED = '-1009770001';
  const swept = (i: number): string => String(-3_000_000 - i);
  const SWEPT = Array.from({ length: SWEEP }, (_, i) => swept(i));

  /** Traffic in chats nobody named — what the cap is there to displace with. */
  const flood = (fake: FakeTelegram, count: number): void => {
    for (let i = 0; i < count; i += 1) fake.injectUserMessage(String(-5_000_000 - i), 'mallory', 'flood');
  };

  interface Method {
    name: string;
    /** Names one topic through the seam. `undefined` for a call that names no topic at all. */
    call(plugin: TelegramPlugin, topic: Topic): Promise<unknown>;
    /** A call that carries no topic cannot mark anything, so it must leave the file untouched. */
    marks: boolean;
  }

  const METHODS: Method[] = [
    { name: 'fetchRecent', marks: true, call: (p, topic) => p.fetchRecent({ topic, limit: 1 }) },
    { name: 'subscribe', marks: true, call: (p, topic) => p.subscribe(topic, () => {}) },
    { name: 'post', marks: true, call: (p, topic) => p.post(topic, SENDER, 'x') },
    {
      name: 'resolveIdentity',
      marks: false,
      call: (p, topic) => p.resolveIdentity(asHandle(`user-${topic as string}`)),
    },
  ];

  it.each(METHODS)(
    '$name over a topic space wider than any bound leaves bounded durable state',
    async ({ call, marks }) => {
      const fake = await startFake();
      const path = storePath();
      const plugin = await connectTo(fake, path, {
        observed_max_chats: 1,
        chat_map: { declared: DECLARED },
      });
      for (const chat of SWEPT) await call(plugin, asTopic(chat));
      await plugin.disconnect();

      // The bookkeeping must never outgrow the records it exists for. A compaction is the only
      // thing that carries these lines out, and armed by record eviction alone nothing here would
      // ever run one: a store that is only ever read has no records to evict.
      expect(servedLines(path)).toBeLessThanOrEqual(marks ? SERVED_ID_MEMORY + lineCount(path) : 1);
      expect(statSync(path).size).toBeLessThan(SERVED_ID_MEMORY * 200 + lineCount(path) * 400);

      // The cap the operator configured still bounds what a caller can exempt from it.
      expect(exemptionsIn(path, SWEPT)).toBeLessThanOrEqual(marks ? SERVED_ID_MEMORY : 0);
    },
    120_000,
  );

  /**
   * Bounding the marks by trimming the one set they all live in would spend the operator's own
   * protection first: `chat_map` chats are marked at connect, so they are the OLDEST entries and
   * the first a newest-last trim drops. A caller who names enough topics would then have bought
   * exactly the eviction the cap exists to prevent, against history the Bot API cannot backfill.
   */
  it('keeps the chats an operator declared exempt however many topics a caller names', async () => {
    const fake = await startFake();
    const path = storePath();
    const plugin = await connectTo(fake, path, {
      observed_max_chats: 1,
      chat_map: { declared: DECLARED },
    });
    const settle = async (marker: string): Promise<void> => {
      fake.injectUserMessage(DECLARED, 'ops', marker);
      await vi.waitFor(async () => expect(await contentsOf(plugin, asTopic('declared'))).toContain(marker), {
        timeout: 15_000,
        interval: 20,
      });
    };
    for (const chat of SWEPT) await plugin.fetchRecent({ topic: asTopic(chat), limit: 1 });
    await settle('mine');
    flood(fake, 40);
    await settle('after the flood');

    expect(await contentsOf(plugin, asTopic('declared'))).toContain('mine');
  }, 120_000);

  /**
   * A chat an operator has since STOPPED declaring is the one case the file's own mark is all that
   * is left of its protection: `chat_map` is re-resolved on every connect, so a declared chat is
   * re-declared before the file is even read, and a mark list that carried only the seam-named ones
   * would lose this chat at the moment its `chat_map` entry goes away rather than ageing it out.
   */
  it('carries a chat the operator has stopped declaring into the next process', () => {
    const path = storePath();
    const store = new ObservedStore(path, 1, 1, [DECLARED]);
    // A rewrite is where the mark list is written; a retention of one evicts on every append.
    for (let i = 1; i <= 8; i += 1) store.append(record('-1009770777', i, `m${i}`));
    store.close();

    expect(exemptionsIn(path, [DECLARED, '-1009770801', '-1009770802'])).toBe(1);
  });

  /**
   * The bound has to hold where the state GROWS and not only where it is written out, so the same
   * property is asserted at two sizes an order of magnitude apart with no constant between them:
   * naming ten times as many chats must not leave ten times as many exempt.
   */
  it('does not exempt more chats the more of them a caller names', () => {
    const names = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => String(-4_000_000 - i));
    /** Exemptions after `count` seam-named chats — the one this process holds, and the one it leaves. */
    const measure = (count: number): { live: number; durable: number } => {
      const chats = names(count);
      const held = new ObservedStore(storePath(), 1, 1);
      for (const chat of chats) held.serve(chat);
      const live = exemptionsHeldBy(held, chats);
      held.close();

      const path = storePath();
      const written = new ObservedStore(path, 1, 1);
      for (const chat of chats) written.serve(chat);
      written.close();
      return { live, durable: exemptionsIn(path, chats) };
    };
    const few = measure(1_200);
    const many = measure(12_000);
    expect(few.live).toBeGreaterThan(0);
    expect(few.durable).toBeGreaterThan(0);
    // Ten times the topics, and not one more exemption: a bound that only bites where the state is
    // written out leaves the running process exempting every chat a caller has ever named.
    expect(many.live).toBeLessThanOrEqual(few.live);
    expect(many.durable).toBeLessThanOrEqual(few.durable);
  }, 120_000);
});
