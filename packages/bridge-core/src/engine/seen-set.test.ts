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
