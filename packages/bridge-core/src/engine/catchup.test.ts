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

/** Await a promise that MUST reject, and hand back the Error (never the resolved value). */
async function rejectionOf(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error('expected the promise to reject, but it resolved');
    },
    (e: unknown) => e as Error,
  );
}
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

  describe('resume-from-disk failures carry an actionable hint', () => {
    const rejectingPlugin = (message: string) =>
      ({
        fetchRecent: () => Promise.reject(new Error(message)),
      }) as unknown as Parameters<typeof catchUpTopic>[0]['plugin'];

    it.each([
      ['invalid input syntax for type bigint: "1785300194045-0"'], // postgres given a redis id
      ['ERR Invalid stream ID specified as stream command argument'], // redis given a bigserial
      ['M_INVALID_PARAM: invalid from token'], // matrix given anything else
    ])('names the state file and the stored cursor (%s)', async (backendError) => {
      const path = rsPath();
      const readState = new ReadStateStore(path);
      readState.set(T, '1785300194045-0' as never);

      await expect(
        catchUpTopic({
          plugin: rejectingPlugin(backendError),
          topic: T,
          limit: 100,
          readState,
          seen: new SeenSet(),
        }),
      ).rejects.toThrow(
        new RegExp(
          `resuming from the stored cursor.*1785300194045-0.*${backendError.slice(0, 12)}`,
          's',
        ),
      );
      const err = await rejectionOf(
        catchUpTopic({
          plugin: rejectingPlugin(backendError),
          topic: T,
          limit: 100,
          readState,
          seen: new SeenSet(),
        }),
      );
      expect(err.message).toContain(path);
      // Assert on `stack`, not only `message`, so that a wrapper which clobbers the stack cannot
      // discard the hint at the one place a human reads it while this test stays green.
      expect(err.stack).toContain('resuming from the stored cursor');
      expect(err.stack).toContain(path);
      expect((err.cause as Error).message).toBe(backendError);
    });

    it('leaves a cold-start failure unadorned (no disk cursor was involved)', async () => {
      const readState = new ReadStateStore(rsPath()); // nothing stored for T
      const err = await rejectionOf(
        catchUpTopic({
          plugin: rejectingPlugin('connection refused'),
          topic: T,
          limit: 100,
          readState,
          seen: new SeenSet(),
        }),
      );
      expect(err.message).toBe('connection refused');
      expect(err.message).not.toMatch(/instance_id/);
    });

    it('does not adorn a mid-pagination failure — that cursor was minted by this same plugin', async () => {
      const p = await seeded(10);
      const readState = new ReadStateStore(rsPath());
      let calls = 0;
      const flaky = {
        fetchRecent: (req: Parameters<typeof p.fetchRecent>[0]) => {
          calls++;
          if (calls > 1) return Promise.reject(new Error('backend went away'));
          return p.fetchRecent(req);
        },
      } as unknown as Parameters<typeof catchUpTopic>[0]['plugin'];

      const err = await rejectionOf(
        catchUpTopic({ plugin: flaky, topic: T, limit: 3, readState, seen: new SeenSet() }),
      );
      expect(err.message).toBe('backend went away');
    });
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
