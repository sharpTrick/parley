import { describe, expect, it } from 'vitest';
import { asBackendMsgId, asTopic, type Topic } from '../message.js';
import { parseConfig } from '../config.js';
import { MAX_FETCH_LIMIT } from '../transport/tools.js';
import { SeenSet, SEEN_MAX_PER_TOPIC, SEEN_MAX_TOPICS } from './seen-set.js';

const T = asTopic('t');
const T2 = asTopic('t2');
const id = (n: number) => asBackendMsgId(String(n));

describe('SeenSet', () => {
  it('firstSeen is true once, false on repeat', () => {
    const s = new SeenSet();
    expect(s.firstSeen(T, id(1))).toBe(true);
    expect(s.firstSeen(T, id(1))).toBe(false);
    expect(s.firstSeen(T, id(2))).toBe(true);
  });

  /**
   * The capacity, against the figure it is a budget for. Push delivers a subset of the tail and a
   * reconciling `parley_fetch_recent` covers the rest, so the window has to hold one whole such
   * page — `MAX_FETCH_LIMIT` ids — with room for the push traffic that lands beside it. A window
   * shorter than that means the oldest ids of a reconciling read are evicted by the traffic
   * concurrent with it, and the push loop re-emits as `<channel>` events what the agent just pulled.
   *
   * The figure and the exercise are the SAME number here. Asserting one budget while filling the
   * window with another leaves the difference ungraded: the bound said four pages, the body wrote
   * two, and three would have passed the bound and lost the read's oldest id.
   */
  const RECONCILING_PAGES = 4;

  it('holds several whole reconciling pages, so one read cannot flush its own oldest ids', () => {
    expect(SEEN_MAX_PER_TOPIC).toBeGreaterThanOrEqual(RECONCILING_PAGES * MAX_FETCH_LIMIT);
    const s = new SeenSet();
    for (let i = 0; i < MAX_FETCH_LIMIT; i++) s.markSeen(T, id(i));
    // …and the whole budget's worth of live traffic lands beside it before the first id is read
    // back, so a window one page shorter than the bound loses it.
    for (let i = MAX_FETCH_LIMIT; i < RECONCILING_PAGES * MAX_FETCH_LIMIT; i++) {
      s.firstSeen(T, id(i));
    }
    expect(s.has(T, id(0))).toBe(true);
  });

  /**
   * The OTHER reconciling path, and the reason the budget above is not the whole story:
   * `catchUpTopic` pages at `catchup.limit`, which the config declares positive with NO ceiling —
   * so a deployment can ask for a page this window cannot hold, and the tool's `MAX_FETCH_LIMIT`
   * clamp does not reach it. What is bounded is the DEFAULT, and a default raised past the budget
   * would silently make every start-up catch-up re-emit its own oldest rows as `<channel>` events.
   */
  it('the default catch-up page fits the window, on the path no server-side cap clamps', () => {
    const cfg = parseConfig({ identity: { handle: 'a' }, topics: ['t'], backend_config: {} });
    expect(cfg.catchup.limit).toBeLessThanOrEqual(SEEN_MAX_PER_TOPIC / RECONCILING_PAGES);
  });

  it('dedup is per-topic (same id in different topics are independent)', () => {
    const s = new SeenSet();
    expect(s.firstSeen(T, id(1))).toBe(true);
    expect(s.firstSeen(T2, id(1))).toBe(true);
    expect(s.firstSeen(T, id(1))).toBe(false);
  });

  it('markSeen suppresses a later firstSeen (catch-up warms the set)', () => {
    const s = new SeenSet();
    s.markSeen(T, id(5));
    expect(s.has(T, id(5))).toBe(true);
    expect(s.firstSeen(T, id(5))).toBe(false);
  });

  /**
   * The per-topic cap bounds ids; nothing bounded the number of TOPICS. With a `post_topics`
   * pattern the topic space is open and `fetch_recent` warms a bucket for whatever topic it is
   * handed, so an agent reading ad-hoc topics grew this map for the process lifetime. Generate over
   * topic counts rather than picking one, so a later cache of the same shape is covered too.
   */
  describe('the topic key space is bounded, not just the ids inside each topic', () => {
    const MAX_TOPICS = 8;
    const surviving = (s: SeenSet, n: number): number =>
      Array.from({ length: n }, (_, i) => asTopic(`t${i}`)).filter((t) => s.has(t, id(1))).length;

    it.each([9, 32, 500, 5000])('stays bounded across %i distinct topics', (n) => {
      const s = new SeenSet(4, MAX_TOPICS);
      for (let i = 0; i < n; i++) s.markSeen(asTopic(`t${i}`), id(1));
      expect(surviving(s, n)).toBeLessThanOrEqual(MAX_TOPICS);
    });

    it('evicts the coldest topics and keeps the most recent ones', () => {
      const s = new SeenSet(4, MAX_TOPICS);
      for (let i = 0; i < 100; i++) s.markSeen(asTopic(`t${i}`), id(1));
      expect(s.has(asTopic('t0'), id(1))).toBe(false);
      expect(s.has(asTopic('t99'), id(1))).toBe(true);
      expect(s.has(asTopic(`t${100 - MAX_TOPICS}`), id(1))).toBe(true);
    });

    /**
     * Which topics survive is decided by the LAST WRITE, not by the order they were first added —
     * that refresh is the whole reason a live push topic outlives a wave of ad-hoc `fetch_recent`
     * ones. A wave no larger than the cap evicts nothing and therefore grades nothing, so every row
     * here overflows it, and each asserts the whole survivor SET: insert-order FIFO answers a
     * different set for the interleaved pattern, and any policy that keeps or drops everything fails
     * the controls. The same shape grades any later bounded cache in core.
     */
    describe('eviction keeps the most-recently-WRITTEN topics, not the first-added ones', () => {
      const hot = asTopic('hot');
      const noise = (n: number) => Array.from({ length: n }, (_unused, i) => asTopic(`n${i}`));

      const PATTERNS = {
        'written once, before the wave': (n: number) => [hot, ...noise(n)],
        'written once, after the wave': (n: number) => [...noise(n), hot],
        'refreshed before every new topic': (n: number) => noise(n).flatMap((t) => [hot, t]),
      };

      /** The declared policy: the `maxTopics` topics whose most recent write is the latest. */
      const survivorsOf = (seq: Topic[], maxTopics: number): Set<Topic> => {
        const lastWrite = new Map<Topic, number>();
        seq.forEach((t, i) => lastWrite.set(t, i));
        return new Set(
          [...lastWrite]
            .sort(([, a], [, b]) => b - a)
            .slice(0, maxTopics)
            .map(([t]) => t),
        );
      };

      const CELLS = [2, 4, MAX_TOPICS].flatMap((maxTopics) =>
        [maxTopics + 1, maxTopics * 2, maxTopics * 10].flatMap((wave) =>
          (Object.keys(PATTERNS) as Array<keyof typeof PATTERNS>).map(
            (pattern) => [maxTopics, wave, pattern] as const,
          ),
        ),
      );

      it.each(CELLS)('maxTopics=%i, a wave of %i, the hot topic %s', (maxTopics, wave, pattern) => {
        const seq = PATTERNS[pattern](wave);
        const s = new SeenSet(4, maxTopics);
        for (const t of seq) s.markSeen(t, id(1));
        const alive = new Set([...new Set(seq)].filter((t) => s.has(t, id(1))));
        expect(alive).toEqual(survivorsOf(seq, maxTopics));
      });
    });

    it('a read is not a write: has() and a repeat firstSeen do not refresh recency', () => {
      const s = new SeenSet(4, 2);
      s.markSeen(T, id(1));
      s.markSeen(T2, id(1));
      expect(s.has(T, id(1))).toBe(true);
      expect(s.firstSeen(T, id(1))).toBe(false);
      s.markSeen(asTopic('t3'), id(1)); // overflows: the coldest by WRITE is still T
      expect(s.has(T, id(1))).toBe(false);
      expect(s.has(T2, id(1))).toBe(true);
    });
  });

  /**
   * Every other case here INJECTS its own capacity, so the no-argument constructor the composition
   * roots actually use was graded nowhere: collapsing either default to 2 left the whole suite
   * green while a three-topic bridge re-emitted `<channel>` events on every catch-up/live overlap.
   * Grade the default-constructed instance at its boundary, and pin the two numbers by VALUE as
   * well — a table derived from the constants moves with them and cannot see a silent shrink.
   */
  describe('the shipped defaults are the ones a no-argument SeenSet gets', () => {
    it('pins the documented capacity', () => {
      expect([SEEN_MAX_PER_TOPIC, SEEN_MAX_TOPICS]).toEqual([4096, 256]);
    });

    it('holds exactly maxPerTopic ids in one topic before evicting the oldest', () => {
      const s = new SeenSet();
      for (let i = 0; i < SEEN_MAX_PER_TOPIC; i++) s.markSeen(T, id(i));
      expect(s.has(T, id(0))).toBe(true); // at the cap nothing has been dropped yet
      expect(s.has(T, id(SEEN_MAX_PER_TOPIC - 1))).toBe(true);
      s.markSeen(T, id(SEEN_MAX_PER_TOPIC)); // one past it evicts exactly the oldest
      expect(s.has(T, id(0))).toBe(false);
      expect(s.has(T, id(1))).toBe(true);
      expect(s.has(T, id(SEEN_MAX_PER_TOPIC))).toBe(true);
    });

    it('holds exactly maxTopics buckets before evicting the coldest', () => {
      const s = new SeenSet();
      const topic = (i: number) => asTopic(`t${i}`);
      for (let i = 0; i < SEEN_MAX_TOPICS; i++) s.markSeen(topic(i), id(1));
      expect(s.has(topic(0), id(1))).toBe(true);
      s.markSeen(topic(SEEN_MAX_TOPICS), id(1));
      expect(s.has(topic(0), id(1))).toBe(false);
      expect(s.has(topic(1), id(1))).toBe(true);
      expect(s.has(topic(SEEN_MAX_TOPICS), id(1))).toBe(true);
    });
  });

  it('evicts FIFO past the cap but keeps recent ids', () => {
    const s = new SeenSet(3);
    for (const n of [1, 2, 3]) s.firstSeen(T, id(n));
    s.firstSeen(T, id(4)); // evicts id(1)
    expect(s.has(T, id(1))).toBe(false);
    expect(s.has(T, id(2))).toBe(true);
    expect(s.has(T, id(4))).toBe(true);
    // id(1) past the window looks "new" again — acceptable: cursor monotonicity means
    // we never actually re-encounter ancient ids except across the catch-up/live boundary.
    expect(s.firstSeen(T, id(1))).toBe(true);
  });
});
