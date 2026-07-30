import { asCursor, asTopic, type Cursor } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { fakeJetStream, injectFake, payload } from './fake-jetstream.js';

// Class 1: every server-side resource this plugin creates is destroyed on EVERY exit path — a throw
// between creating an ephemeral consumer and deleting it leaks one per call, and a flapping link
// with per-topic polling accumulates them. Fake-backed, so it runs with no server; the live half of
// this class lives in resource-live.test.ts, in its own FILE so that a server that failed to come
// up trips CI's whole-file skip gate instead of silently deleting its own coverage.
// Class 2: a read reports a backend fault as a fault, on every read shape. `block_ms` selects a
// separate native long-poll branch, and a branch that reports faults as "nothing new" turns an
// auth or permission failure into a bridge that polls forever and says the topic is quiet — while
// the identical call without `block_ms` raises. The two terminations a long-poll MUST swallow
// (its own deadline, and disconnect()) are asserted in the same table, so narrowing the swallow
// cannot be traded for silencing a real fault.
const TOPIC = asTopic('leak');

const faults: ('get' | 'fetch' | 'iterate')[] = ['get', 'fetch', 'iterate'];

const readShapes: {
  name: string;
  records: { seq: number; data: string }[];
  args: { topic: typeof TOPIC; since?: Cursor; blockMs?: number };
}[] = [
  { name: 'catch-up with no since', records: [{ seq: 1, data: payload('a') }], args: { topic: TOPIC } },
  {
    name: 'catch-up from a since',
    records: [{ seq: 1, data: payload('a') }, { seq: 2, data: payload('b') }],
    args: { topic: TOPIC, since: asCursor('1') },
  },
  {
    name: 'a blockMs long-poll',
    records: [],
    args: { topic: TOPIC, since: asCursor('0'), blockMs: 1000 },
  },
];

const outcome = async (run: () => Promise<unknown>): Promise<string> =>
  run().then(
    () => 'resolved',
    () => 'rejected',
  );

describe('nats reads — a backend fault is a fault on every read shape', () => {
  for (const shape of readShapes) {
    for (const failOn of [...faults, null]) {
      it(`${shape.name} ${failOn === null ? 'resolves when the read succeeds' : `rejects when the read throws in ${failOn}`}`, async () => {
        const fake = fakeJetStream({ records: shape.records, failOn });
        const plugin = new NatsPlugin();
        injectFake(plugin, fake, TOPIC);

        expect(await outcome(() => plugin.fetchRecent(shape.args))).toBe(
          failOn === null ? 'resolved' : 'rejected',
        );

        // Class 1 rides along on every cell: whatever the outcome, nothing is left behind.
        expect(fake.state.created.length).toBeGreaterThanOrEqual(1);
        expect(fake.state.deleted).toEqual(fake.state.created);
      });
    }
  }

  const swallowed = [
    {
      name: 'its own deadline expires',
      run: async (plugin: NatsPlugin) =>
        plugin.fetchRecent({ topic: TOPIC, since: asCursor('0'), blockMs: 300 }),
    },
    {
      name: 'disconnect() closes it',
      run: async (plugin: NatsPlugin) => {
        const pending = plugin.fetchRecent({ topic: TOPIC, since: asCursor('0'), blockMs: 30_000 });
        await new Promise((r) => setTimeout(r, 200));
        await plugin.disconnect();
        return pending;
      },
    },
  ];

  for (const termination of swallowed) {
    it(`a long-poll returns an empty page when ${termination.name}`, async () => {
      const fake = fakeJetStream({ records: [], expiryMs: 10_000, throwOnClose: true });
      const plugin = new NatsPlugin();
      injectFake(plugin, fake, TOPIC);

      const page = await termination.run(plugin);
      expect(page).toEqual({ messages: [], nextCursor: '0' });
      expect(fake.state.deleted).toEqual(fake.state.created);
    }, 20_000);
  }
});
