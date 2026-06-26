import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asBackendMsgId, asHandle, asTopic } from '../message.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { catchUpAll, catchUpTopic } from './catchup.js';
import { ReadStateStore } from './read-state.js';
import { SeenSet } from './seen-set.js';

const rsPath = () => join(mkdtempSync(join(tmpdir(), 'parley-cu-')), 'read-state.json');
const T = asTopic('ctx');
const me = asHandle('alice');

async function seeded(n: number, prefix = 'm') {
  const p = new FakePlugin();
  await p.connect({});
  for (let i = 0; i < n; i++) await p.post(T, me, `${prefix}${i}`);
  return p;
}

describe('catch-up driver', () => {
  it('drains all, warms the seen-set, advances read-state', async () => {
    const p = await seeded(5);
    const readState = new ReadStateStore(rsPath());
    const seen = new SeenSet();
    const n = await catchUpTopic({ plugin: p, topic: T, limit: 100, readState, seen });
    expect(n).toBe(5);
    expect(readState.get(T)).toBe('5'); // cursor of the last message
    expect(seen.has(T, asBackendMsgId('5'))).toBe(true);
    // warmed: a message already pulled should NOT count as first-seen on the push path
    expect(seen.firstSeen(T, asBackendMsgId('3'))).toBe(false);
  });

  it('second catch-up returns only newer (exclusive since)', async () => {
    const p = await seeded(3, 'a');
    const readState = new ReadStateStore(rsPath());
    const seen = new SeenSet();
    expect(await catchUpTopic({ plugin: p, topic: T, limit: 100, readState, seen })).toBe(3);
    for (let i = 0; i < 2; i++) await p.post(T, me, `b${i}`);
    expect(await catchUpTopic({ plugin: p, topic: T, limit: 100, readState, seen })).toBe(2);
    expect(readState.get(T)).toBe('5');
    // fully drained → no further messages
    expect(await catchUpTopic({ plugin: p, topic: T, limit: 100, readState, seen })).toBe(0);
  });

  it('paginates when limit < total', async () => {
    const p = await seeded(10);
    const readState = new ReadStateStore(rsPath());
    const seen = new SeenSet();
    const n = await catchUpTopic({ plugin: p, topic: T, limit: 3, readState, seen });
    expect(n).toBe(10);
    expect(readState.get(T)).toBe('10');
  });

  it('catchUpAll loops over every configured topic', async () => {
    const p = new FakePlugin();
    await p.connect({});
    const A = asTopic('a');
    const B = asTopic('b');
    await p.post(A, me, 'x');
    await p.post(B, me, 'y');
    await p.post(B, me, 'z');
    const readState = new ReadStateStore(rsPath());
    const seen = new SeenSet();
    expect(await catchUpAll({ plugin: p, topics: [A, B], limit: 100, readState, seen })).toBe(3);
    expect(readState.get(A)).toBe('1');
    expect(readState.get(B)).toBe('3');
  });
});
