import { asCursor, asHandle, asTopic, catchUpTopic, ReadStateStore, SeenSet } from '@sharptrick/parley-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatrixPlugin } from '../src/index.js';
import { connectFake, FakeSynapse } from './fake-synapse.js';

/**
 * Work item 17 — Matrix catch-up & sync correctness (BUG-03 / BUG-09 / BUG-10).
 *
 * These drive the ACTUAL plugin code (fetchRecent / subscribe / backfill) against the in-memory
 * fake Synapse in `./fake-synapse.ts`. No live homeserver: the conformance suite
 * (`conformance.test.ts`) covers the live drive and is `describe.skip`'d when no Synapse answers.
 * This file is the code-level proof that each fix genuinely changes the runtime behavior, not
 * merely that the suite is green.
 */

let fake: FakeSynapse;
const install = (): FakeSynapse => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
  return fake;
};

const connect = (shared: boolean): Promise<MatrixPlugin> => connectFake({ shared });

const rsPath = () => join(mkdtempSync(join(tmpdir(), 'parley-mx-')), 'read-state.json');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BUG-03 — fetchRecent since-path drains a foreign block and always advances the cursor', () => {
  it('shared_room: a later on-topic message after a full page of foreign-topic events is returned', async () => {
    install();
    const p = await connect(true);
    const A = asTopic('topic-A');
    const B = asTopic('topic-B');
    const writer = asHandle('w');

    const idA0 = await p.post(A, writer, 'a0'); // cursor X for topic A
    for (let i = 0; i < 5; i++) await p.post(B, writer, `b${i}`); // a full page (limit=5) of foreign topic
    const idA1 = await p.post(A, writer, 'a1'); // the message that MUST stay reachable

    const res = await p.fetchRecent({ topic: A, since: asCursor(String(idA0)), limit: 5 });

    // The trailing A message is returned rather than masked forever behind the foreign page.
    expect(res.messages.map((m) => m.content)).toEqual(['a1']);
    // nextCursor strictly advanced past X (it is a1's cursor, never the input `since`).
    expect(String(res.nextCursor)).not.toBe(String(idA0));
    expect(String(res.nextCursor)).toBe(String(idA1));
    await p.disconnect();
  });

  it('any-room-mode: a full page of non-m.room.message events (reactions) does not wedge the cursor', async () => {
    const f = install();
    const p = await connect(false); // per-topic room mode
    const T = asTopic('reacty');
    const writer = asHandle('w');

    const idT0 = await p.post(T, writer, 't0');
    for (let i = 0; i < 5; i++) f.addRaw('m.reaction'); // a full page of non-message churn
    const idT1 = await p.post(T, writer, 't1');

    const res = await p.fetchRecent({ topic: T, since: asCursor(String(idT0)), limit: 5 });
    expect(res.messages.map((m) => m.content)).toEqual(['t1']);
    expect(String(res.nextCursor)).toBe(String(idT1));
    await p.disconnect();
  });

  it('catchUpTopic over the same shared room counts the trailing A message and advances read-state past X', async () => {
    install();
    const p = await connect(true);
    const A = asTopic('cu-A');
    const B = asTopic('cu-B');
    const writer = asHandle('w');

    const idA0 = await p.post(A, writer, 'a0');
    for (let i = 0; i < 5; i++) await p.post(B, writer, `b${i}`);
    const idA1 = await p.post(A, writer, 'a1');

    const readState = new ReadStateStore(rsPath());
    const seen = new SeenSet();
    readState.set(A, asCursor(String(idA0))); // persisted cursor stuck at X before the fix

    const total = await catchUpTopic({ plugin: p, topic: A, limit: 5, readState, seen });

    expect(total).toBe(1); // drains the trailing a1 rather than breaking early at 0
    expect(String(readState.get(A))).toBe(String(idA1)); // read-state crossed the foreign block
    await p.disconnect();
  });
});

describe('BUG-09 — subscribe recovers a burst larger than the per-sync cap via prev_batch', () => {
  it('delivers ALL N events ascending with no gap and no duplicate when the server truncates', async () => {
    const f = install();
    f.syncCap = 2; // server truncates any incremental sync to 2 events → forces limited:true
    const p = await connect(false); // per-topic room, fresh (no prior history)
    const T = asTopic('burst');

    const got: string[] = [];
    await p.subscribe(T, (m) => got.push(m.content));

    // While the loop is between polls, a burst of 5 lands (5 > syncCap 2 → the server drops 3).
    for (let i = 0; i < 5; i++) f.addMessage(String(T), `m${i}`);

    await vi.waitFor(() => expect(got.length).toBe(5), { timeout: 4000, interval: 10 });

    expect(got).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']); // ascending, complete, in order
    expect(new Set(got).size).toBe(5); // no duplicate delivery
    expect(f.limitedEmitted).toBeGreaterThan(0); // the truncation/backfill path actually ran
    await p.disconnect();
  });
});

describe('issue #20 — fetchRecent honors blockMs natively via a bounded /sync long-poll', () => {
  it('wakes promptly when a message lands mid-wait, returning it via the canonical catch-up', async () => {
    install();
    const p = await connect(false); // per-topic room; no subscribe loop → dedicated bounded /sync
    const T = asTopic('block-wake');
    const writer = asHandle('w');

    await p.post(T, writer, 'old');
    const tail = (await p.fetchRecent({ topic: T })).nextCursor;

    const pending = p.fetchRecent({ topic: T, since: tail, blockMs: 2000 });
    // A message lands ~60ms into the wait (after the first bounded /sync has parked).
    setTimeout(() => void p.post(T, writer, 'fresh'), 60);

    const woke = await pending;
    expect(woke.messages.map((m) => m.content)).toEqual(['fresh']);
    expect(String(woke.nextCursor)).not.toBe(String(tail)); // cursor advanced past the floor
    await p.disconnect();
  });

  it('returns an empty page with a stable, replayable cursor at the blockMs timeout', async () => {
    install();
    const p = await connect(false);
    const T = asTopic('block-timeout');
    const writer = asHandle('w');

    await p.post(T, writer, 'only');
    const tail = (await p.fetchRecent({ topic: T })).nextCursor;

    const started = Date.now();
    const timedOut = await p.fetchRecent({ topic: T, since: tail, blockMs: 250 });
    expect(timedOut.messages).toEqual([]);
    expect(String(timedOut.nextCursor)).toBe(String(tail)); // stable — replaying it yields [] again
    expect(Date.now() - started).toBeGreaterThanOrEqual(150); // actually blocked, not instant
    await p.disconnect();
  });

  it('disconnect() aborts an in-flight blocking fetch promptly (no leak, no hang)', async () => {
    install();
    const p = await connect(false);
    const T = asTopic('block-disconnect');
    const writer = asHandle('w');

    await p.post(T, writer, 'seed');
    const tail = (await p.fetchRecent({ topic: T })).nextCursor;

    const started = Date.now();
    const pending = p.fetchRecent({ topic: T, since: tail, blockMs: 5000 });
    setTimeout(() => void p.disconnect(), 50);

    const res = await pending; // must resolve well before the 5s budget
    expect(res.messages).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('BUG-10 — a purged/remapped cursor 404 falls back to the recent window instead of throwing', () => {
  it('fetchRecent with an unresolvable since resolves to the recent window (no throw)', async () => {
    const f = install();
    const p = await connect(false);
    const T = asTopic('stale');
    const writer = asHandle('w');
    await p.post(T, writer, 'a');
    await p.post(T, writer, 'b');
    await p.post(T, writer, 'c');

    // Sanity: an unknown event id 404s on /context in the fake (matching M_NOT_FOUND).
    expect(f.timeline.find((e) => e.event_id === '$purged:fake')).toBeUndefined();

    const res = await p.fetchRecent({ topic: T, since: asCursor('$purged:fake'), limit: 100 });
    expect(res.messages.map((m) => m.content)).toEqual(['a', 'b', 'c']); // recent window, ascending
    expect(String(res.nextCursor)).toBe(String(res.messages.at(-1)!.backendMsgId));
    await p.disconnect();
  });

  it('catchUpTopic (the startup path) comes up cleanly with a stale persisted cursor', async () => {
    install();
    const p = await connect(false);
    const T = asTopic('startup');
    const writer = asHandle('w');
    await p.post(T, writer, 'x');
    await p.post(T, writer, 'y');

    const readState = new ReadStateStore(rsPath());
    const seen = new SeenSet();
    readState.set(T, asCursor('$gone:fake')); // stale/purged cursor persisted from a prior run

    // Must NOT throw a "Matrix GET .../context/$gone → 404" — that is what bricked startup.
    const total = await catchUpTopic({ plugin: p, topic: T, limit: 100, readState, seen });
    expect(total).toBe(2); // resumed from the recent window
    await p.disconnect();
  });
});
