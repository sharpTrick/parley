import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectFake, type Ev, FakeSynapse } from './fake-synapse.js';

/**
 * CLASS: a write-idempotency key the backend enforces must be exercised in BOTH directions. Matrix
 * deduplicates `PUT .../send/m.room.message/<txnId>` per access token, which is simultaneously what
 * makes a REUSED txn id total write loss (the homeserver replays the first event's id and stores
 * nothing) and what makes `fetchWithRetry`'s re-send of an identical `PUT` after a 429 safe (the
 * homeserver stores one event, not two). Neither direction is reachable from a fake that appends on
 * every PUT, so both are graded here against one that keys the transaction the way Synapse does.
 */

const TOPIC = asTopic('idempotent');
const WRITER = asHandle('writer');
const N = 5;

let fake: FakeSynapse;
beforeEach(() => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const bodies = (): unknown[] =>
  fake.allEvents.filter((e: Ev) => e.type === 'm.room.message').map((e: Ev) => (e.content as { body?: unknown }).body);

const sendAttempts = (): number =>
  fake.requestUrls.filter((u) => /\/send\/m\.room\.message\//.test(u.pathname)).length;

/** Whether the posts race each other — two writes minting a txn id in the same millisecond. */
const ARRIVALS: Record<string, (post: (i: number) => Promise<string>) => Promise<string[]>> = {
  sequential: async (post) => {
    const ids: string[] = [];
    for (let i = 0; i < N; i++) ids.push(await post(i));
    return ids;
  },
  concurrent: (post) => Promise.all(Array.from({ length: N }, (_v, i) => post(i))),
};

describe('a distinct transaction id per post', () => {
  for (const [name, arrive] of Object.entries(ARRIVALS)) {
    it(`${N} ${name} posts of the SAME content yield ${N} distinct ids and ${N} timeline entries`, async () => {
      const p = await connectFake({});
      // Identical content, so nothing but the txn id can distinguish the writes.
      const ids = await arrive(async () => String(await p.post(TOPIC, WRITER, 'same')));

      expect(new Set(ids).size).toBe(N);
      expect(bodies()).toEqual(Array.from({ length: N }, () => 'same'));
      await p.disconnect();
    });
  }

  it('two plugin instances sharing one account and one topic never collide on a txn id', async () => {
    const a = await connectFake({});
    const b = await connectFake({});
    // Resolve both instances' room cache FIRST, so that the contending writes below mint their txn
    // ids with no round-trip between them — two bridges whose per-instance counters are at the same
    // value in the same millisecond is the collision this row exists for, and a warm-up round-trip
    // is what would otherwise separate them by luck.
    await Promise.all([a.post(TOPIC, WRITER, 'warm'), b.post(TOPIC, WRITER, 'warm')]);
    const before = bodies().length;

    const ids = await Promise.all([
      ...Array.from({ length: N }, () => a.post(TOPIC, WRITER, 'same')),
      ...Array.from({ length: N }, () => b.post(TOPIC, WRITER, 'same')),
    ]);

    expect(new Set(ids.map(String)).size).toBe(2 * N);
    expect(bodies().length - before).toBe(2 * N);
    await a.disconnect();
    await b.disconnect();
  });
});

describe('a post whose PUT is rate limited is retried, not duplicated', () => {
  it('a 429-then-retry yields exactly one timeline entry and returns that entry id', async () => {
    fake.sendLimited = 1;
    fake.sendRetryAfterMs = 60;
    const p = await connectFake({});

    const id = String(await p.post(TOPIC, WRITER, 'once'));

    expect(sendAttempts()).toBe(2); // refused once, then re-sent
    expect(bodies()).toEqual(['once']);
    expect(fake.allEvents.map((e: Ev) => e.event_id)).toContain(id);
    // …and the read path agrees: the retry is one message, not two.
    expect((await p.fetchRecent({ topic: TOPIC, limit: 10 })).messages.map((m) => m.content)).toEqual(
      ['once'],
    );
    await p.disconnect();
  }, 20_000);
});
