import { readFileSync, statSync } from 'node:fs';
import { asTopic, asHandle, type Topic } from '@sharptrick/parley-core';
import { MAX_ERROR_BODY } from '@sharptrick/parley-net-util';
import { describe, expect, it, vi } from 'vitest';
import { CALLER_KIND_MEMORY, Diagnostics } from '../src/diagnostics.js';
import type { TelegramPlugin } from '../src/index.js';
import { ObservedStore, SERVED_ID_MEMORY } from '../src/store.js';
import type { FakeTelegram } from './fake-telegram.js';
import {
  captureStderr,
  connectTo,
  contentsOf,
  lineCount,
  record,
  SENDER,
  startFake,
  startRig,
  storePath,
} from './rig.js';

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

  /**
   * The LIVE half of the same class. A topic that resolves to no chat is reported, and the report is
   * throttled per class — but the class was spelled `unresolved-topic:${topic}`, so the throttle map
   * was keyed by caller-chosen text: 500 `fetchRecent` calls on 500 unresolvable topics grew it from
   * 0 to 500 entries, and it was still 500 after `disconnect()`, on an instance that outlives the
   * connection. Same driver as the durable half above — a topic space core admits by `post_topics`
   * regex — so the rows sweep the same METHODS table and a seam method added there is graded here
   * too.
   *
   * The bound is measured as LINES WRITTEN rather than off a private field: an entry is only ever
   * recorded when a line is emitted, so the count of lines is an upper bound on the map, and it is
   * also the thing an operator actually pays. That is why the fix is not an LRU — evicting a
   * resident entry bounds the map and unbounds the log, since a caller recycling names would then
   * buy back every line the throttle withheld.
   */
  const unresolvable = (i: number): Topic => asTopic(`no-such-chat-${i}`);
  const unresolvedLines = (stderr: readonly string[]): number =>
    stderr.filter((line) => line.includes('resolves to no Telegram chat')).length;

  it.each(METHODS)(
    '$name over an unresolvable topic space writes a bounded number of diagnostics',
    async ({ call, marks }) => {
      const stderr = captureStderr();
      const fake = await startFake();
      const plugin = await connectTo(fake, storePath());
      const sweep = async (): Promise<void> => {
        for (let i = 0; i < SWEEP; i += 1) {
          await call(plugin, unresolvable(i)).catch(() => undefined);
        }
      };
      await sweep();
      const written = unresolvedLines(stderr);
      // A call that names no topic resolves nothing and must stay silent; one that does has to have
      // said something, or the bound below would be graded against a plugin that reports nothing.
      expect({ said: written > 0 }).toEqual({ said: marks });
      expect(written).toBeLessThanOrEqual(marks ? CALLER_KIND_MEMORY + 1 : 0);

      // And sweeping the same space again buys nothing: past the bound a further topic shares its
      // class's single throttle, so recycling names cannot walk the log up one line at a time.
      await sweep();
      expect(unresolvedLines(stderr)).toBe(written);
    },
    120_000,
  );

  /**
   * The throttle KEY is caller-chosen text too, so bounding the number of entries while each one
   * holds a whole topic is the same unbounded growth one entry at a time — a topic is a bare
   * `z.string()` at the MCP boundary, with no length of its own.
   */
  it('holds two topics that differ only past the length bound to one throttle', async () => {
    const stderr = captureStderr();
    const fake = await startFake();
    const plugin = await connectTo(fake, storePath());
    const shared = 'z'.repeat(MAX_ERROR_BODY * 2);
    for (const suffix of ['-alpha', '-beta']) {
      await plugin.fetchRecent({ topic: asTopic(`${shared}${suffix}`) }).catch(() => undefined);
    }
    expect(unresolvedLines(stderr)).toBe(1);

    // Positive control: two topics that differ WITHIN the bound are still two classes, so a row
    // above cannot pass by a throttle that has stopped telling topics apart at all.
    stderr.length = 0;
    for (const suffix of ['-alpha', '-beta']) {
      await plugin.fetchRecent({ topic: asTopic(`short${suffix}`) }).catch(() => undefined);
    }
    expect(unresolvedLines(stderr)).toBe(2);
  }, 60_000);

  /**
   * The caller's names belong to ONE connection, like the chat memos they were resolved through: the
   * `Diagnostics` instance is a field on the plugin and outlives `disconnect()`, so without a
   * release it holds a caller's topics for the life of the process.
   */
  it('reports a topic again once a disconnect has released the throttle holding it', async () => {
    const stderr = captureStderr();
    const rig = await startRig();
    const topic = unresolvable(0);
    await rig.plugin.fetchRecent({ topic }).catch(() => undefined);
    await rig.plugin.fetchRecent({ topic }).catch(() => undefined);
    expect(unresolvedLines(stderr)).toBe(1);

    await rig.plugin.disconnect();
    await rig.reconnect();
    await rig.plugin.fetchRecent({ topic }).catch(() => undefined);
    expect(unresolvedLines(stderr)).toBe(2);
  }, 60_000);

  /**
   * A bound that only ever fills is a bound that goes deaf: a bridge that met 256 unresolvable
   * topics in its first minute would route every LATER one into the shared bucket for the life of
   * the connection. An entry whose window has passed already reports again, so it is holding
   * nothing, and reclaiming it costs no extra line.
   */
  it('gives a class its own throttle again once the window it was held in has passed', () => {
    const stderr = captureStderr();
    const diagnostics = new Diagnostics();
    const sweep = (from: number, count: number): number => {
      stderr.length = 0;
      for (let i = from; i < from + count; i += 1) {
        diagnostics.report(`topic ${i} resolves to nothing`, 'unresolved-topic', `topic-${i}`);
      }
      return stderr.length;
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect(sweep(0, CALLER_KIND_MEMORY * 2)).toBe(CALLER_KIND_MEMORY + 1);
      // Still full and still inside the window: fresh names buy the one shared line and no more.
      expect(sweep(10_000, CALLER_KIND_MEMORY)).toBe(0);

      vi.setSystemTime(Date.now() + 61_000);
      expect(sweep(20_000, CALLER_KIND_MEMORY)).toBe(CALLER_KIND_MEMORY);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * And the caller's half must not be able to spend the OPERATOR's. Bounding the two in one map
   * would make a class this plugin itself spells — a store refusing messages, a poll loop failing —
   * the oldest entry a trim reaches, so a sweep of caller-named topics would un-throttle exactly the
   * diagnostics an operator needs to see once. Driven against `Diagnostics` itself, so the property
   * is graded without having to reproduce each class's fault.
   */
  it('keeps a caller-named sweep from spending the throttle a plugin-named class holds', () => {
    const stderr = captureStderr();
    const diagnostics = new Diagnostics();
    diagnostics.report('the observed store refused a message', 'store-refused');
    for (let i = 0; i < CALLER_KIND_MEMORY * 4; i += 1) {
      diagnostics.report(`caller topic ${i} resolves to nothing`, 'unresolved-topic', `topic-${i}`);
    }
    diagnostics.report('the observed store refused a message', 'store-refused');

    expect(stderr.filter((l) => l.includes('refused a message')).length).toBe(1);
    expect(stderr.filter((l) => l.includes('resolves to nothing')).length).toBeLessThanOrEqual(
      CALLER_KIND_MEMORY + 1,
    );
    // The bound is a bound and not a mute: the classes admitted under it were all reported.
    expect(stderr.filter((l) => l.includes('resolves to nothing')).length).toBe(
      CALLER_KIND_MEMORY + 1,
    );
  });
});
