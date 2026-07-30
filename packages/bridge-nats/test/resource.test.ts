import { asCursor, asHandle, asTopic, type Cursor, type Topic } from '@sharptrick/parley-core';
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

// Class 3: which seam methods may leave a DURABLE server-side object behind, stated as a table over
// every method against both pre-states rather than as a property of the one method that got it
// wrong. A read that provisions lets any caller-named topic spend the cluster's stream and storage
// budget with calls that store nothing — `post_topics` is a regex and inbound is untrusted — so the
// permission is granted per method, and a method added later is refused by default because it has
// no row saying otherwise. `PROBE` composes the fake's own default subject, so the plugin's stream
// cache is left empty and `ensureStream` runs for real.
const PROBE = asTopic('topic');

const seamCalls: {
  name: string;
  provisions: boolean;
  run: (plugin: NatsPlugin, topic: Topic) => Promise<unknown>;
}[] = [
  { name: 'post', provisions: true, run: (p, t) => p.post(t, asHandle('sys'), 'x') },
  { name: 'subscribe', provisions: true, run: (p, t) => p.subscribe(t, () => undefined) },
  { name: 'fetchRecent with no since', provisions: false, run: (p, t) => p.fetchRecent({ topic: t }) },
  {
    name: 'fetchRecent from a since',
    provisions: false,
    run: (p, t) => p.fetchRecent({ topic: t, since: asCursor('0') }),
  },
  {
    name: 'a blockMs long-poll',
    provisions: false,
    run: (p, t) => p.fetchRecent({ topic: t, since: asCursor('0'), blockMs: 300 }),
  },
  { name: 'resolveIdentity', provisions: false, run: (p) => p.resolveIdentity(asHandle('sys')) },
];

const preStates = [
  { name: 'a topic with no stream', absent: true },
  { name: 'a topic whose stream already exists', absent: false },
];

/** Every message a cursor still reaches, read in pages of `limit`. */
async function drain(
  plugin: NatsPlugin,
  topic: Topic,
  from: Cursor,
  limit: number,
): Promise<string[]> {
  const seen: string[] = [];
  let cursor = from;
  for (let page = 0; page < 20; page++) {
    const read = await plugin.fetchRecent({ topic, since: cursor, limit });
    if (read.messages.length === 0) return seen;
    seen.push(...read.messages.map((m) => m.content));
    cursor = read.nextCursor;
  }
  return seen;
}

describe('nats provisioning — only a write may create the topic’s stream', () => {
  for (const call of seamCalls) {
    for (const pre of preStates) {
      it(`${call.name} on ${pre.name} calls streams.add ${call.provisions ? 'once' : 'never'}`, async () => {
        const fake = fakeJetStream({ records: [], streamAbsent: pre.absent });
        const plugin = new NatsPlugin();
        injectFake(plugin, fake);

        await call.run(plugin, PROBE);

        expect(fake.state.addCalls).toBe(call.provisions ? 1 : 0);
      }, 20_000);
    }
  }

  it('a read of a topic with no stream answers with an empty page and a cursor that replays', async () => {
    const fake = fakeJetStream({ records: [], streamAbsent: true });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake);

    const first = await plugin.fetchRecent({ topic: PROBE });
    expect(first.messages).toEqual([]);
    const again = await plugin.fetchRecent({ topic: PROBE, since: first.nextCursor });
    expect(again).toEqual({ messages: [], nextCursor: first.nextCursor });
    expect(fake.state.addCalls).toBe(0);

    // The stream arrives, and the cursor taken before it existed must sit BELOW its first message.
    // Drained in pages SMALLER than the history, because that is the only shape that can tell the
    // two failures apart: a cursor the plugin judges to be from a dead incarnation is served the
    // NEWEST window instead of the oldest, which returns messages while silently skipping the ones
    // below it — invisible whenever one page happens to cover everything.
    const posted = ['m1', 'm2', 'm3', 'm4', 'm5'];
    for (const content of posted) await plugin.post(PROBE, asHandle('sys'), content);
    expect(await drain(plugin, PROBE, first.nextCursor, 2)).toEqual(posted);
  });

  // A stream missing under THIS name while another already carries the topic's subject is a bridge
  // pointed at the wrong stream, not an empty topic — and a read cannot create one to find out.
  it('a read names stream_prefix when another stream already captures the topic’s subject', async () => {
    const fake = fakeJetStream({ records: [], streamAbsent: true, rivalStream: 'OTHER_topic' });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake);

    const err = await plugin.fetchRecent({ topic: PROBE }).then(() => undefined, (e: unknown) => e);
    expect(String(err)).toContain('stream_prefix');
    expect(String(err)).toContain('OTHER_topic');
    expect(fake.state.addCalls).toBe(0);
  });
});
