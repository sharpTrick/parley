import { describe, expect, it } from 'vitest';
import { asBackendMsgId, asTopic } from '../message.js';
import { SeenSet } from './seen-set.js';

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

    it('re-touching a topic keeps it alive across a wave of new ones', () => {
      const s = new SeenSet(4, MAX_TOPICS);
      s.markSeen(T, id(1));
      for (let i = 0; i < MAX_TOPICS - 1; i++) {
        s.markSeen(asTopic(`noise${i}`), id(1));
        s.markSeen(T, id(2)); // the hot topic keeps being written to
      }
      expect(s.has(T, id(2))).toBe(true);
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
