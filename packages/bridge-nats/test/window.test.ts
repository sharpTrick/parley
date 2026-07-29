import { asCursor, asTopic, type Cursor } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { fakeJetStream, injectFake, payload } from './fake-jetstream.js';

// Class: the sequence range of a stream is NOT dense. `max_age` retention prunes the front,
// per-subject limits and message deletes punch holes, so `last_seq - since` over-counts what the
// server can actually deliver. A read that asks for more than exists holds the pull open for its
// whole `expires` — a flat multi-second stall on every catch-up page, invisible in the result.
const TOPIC = asTopic('window');
const STREAM = 'PARLEY_window';
const EXPIRY_MS = 1500;

const stream = (seqs: number[]): { seq: number; data: string }[] =>
  seqs.map((seq) => ({ seq, data: payload(`m${seq}`) }));

const shapes = [
  { name: 'dense stream', seqs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  { name: 'front pruned by max_age', seqs: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
  { name: 'front pruned and interior holes', seqs: [11, 12, 15, 16, 20] },
  { name: 'interior holes only', seqs: [1, 4, 5, 9, 10] },
  { name: 'single message far from seq 1', seqs: [500] },
  { name: 'everything pruned', seqs: [] },
];

const positions: { name: string; since?: string; limit?: number }[] = [
  { name: 'no since' },
  { name: 'no since, small limit', limit: 2 },
  { name: 'since 0 — before first_seq', since: '0' },
  { name: 'since 5 — may predate first_seq', since: '5' },
  { name: 'since 15 — inside the live window', since: '15' },
  { name: 'since 0, small limit', since: '0', limit: 3 },
];

describe('nats fetch window — a sparse range must not burn the pull expiry', () => {
  for (const shape of shapes) {
    for (const pos of positions) {
      it(`${shape.name}, ${pos.name}: returns promptly and never invents a window`, async () => {
        const fake = fakeJetStream({ records: stream(shape.seqs), expiryMs: EXPIRY_MS });
        const plugin = new NatsPlugin();
        injectFake(plugin, fake, STREAM);
        const args = {
          topic: TOPIC,
          ...(pos.since === undefined ? {} : { since: asCursor(pos.since) }),
          ...(pos.limit === undefined ? {} : { limit: pos.limit }),
        };

        const started = Date.now();
        const page = await plugin.fetchRecent(args);
        const elapsed = Date.now() - started;

        expect(elapsed).toBeLessThan(EXPIRY_MS / 2);
        expect(page.messages.length).toBeLessThanOrEqual(pos.limit ?? 100);
        const seqs = page.messages.map((m) => Number(m.cursor));
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        expect(seqs.every((s) => shape.seqs.includes(s))).toBe(true);
        if (page.messages.length > 0) expect(page.nextCursor).toBe(page.messages.at(-1)?.cursor);
      });
    }
  }

  it('an empty read from a long-dead cursor resumes at the retained window, not inside the gap', async () => {
    const fake = fakeJetStream({ records: stream([11, 12, 13]), yieldLimit: 0 });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, STREAM);

    const page = await plugin.fetchRecent({ topic: TOPIC, since: asCursor('2') });

    expect(page.messages).toHaveLength(0);
    expect(page.nextCursor).toBe('10');

    fake.state.yieldLimit = Number.POSITIVE_INFINITY;
    const resumed = await plugin.fetchRecent({ topic: TOPIC, since: page.nextCursor });
    expect(resumed.messages.map((m) => m.content)).toEqual(['m11', 'm12', 'm13']);
  });

  it('draining a pruned stream from a long-dead cursor still yields every retained message', async () => {
    const fake = fakeJetStream({ records: stream([11, 12, 15, 16, 20]), expiryMs: EXPIRY_MS });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, STREAM);

    const seen: string[] = [];
    let since: Cursor = asCursor('0');
    const started = Date.now();
    for (let i = 0; i < 8; i++) {
      const page = await plugin.fetchRecent({ topic: TOPIC, since, limit: 2 });
      if (page.messages.length === 0) break;
      seen.push(...page.messages.map((m) => m.content));
      since = page.nextCursor;
    }

    expect(seen).toEqual(['m11', 'm12', 'm15', 'm16', 'm20']);
    expect(Date.now() - started).toBeLessThan(EXPIRY_MS);
  });
});
