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

const faults: ('info' | 'get' | 'fetch' | 'iterate')[] = ['info', 'get', 'fetch', 'iterate'];

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

        // Class 1 rides along on every cell: whatever the outcome, nothing is left behind. A fault
        // at the stream gate is answered before any consumer exists; every other point is past it,
        // so the equality below cannot be satisfied by two empty lists.
        expect(fake.state.created.length > 0).toBe(failOn !== 'info');
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

  // The read has TWO branches — the stream is there, or the long poll waits for the `post` that
  // will make it — and each reaches the server through a different call. A swallow written for one
  // is not a swallow for the other: the absent branch polls `streams.info`, which is exactly the
  // handle `disconnect()` clears, so the same teardown that the present branch answers with an
  // empty page came back out of it as `NatsPlugin not connected`. Cross the two axes, so that a
  // termination this plugin caused itself is graded on every branch rather than on the one that
  // happened to be tabled.
  const streamStates: {
    name: string;
    init: Record<string, unknown>;
    arm?: (fake: ReturnType<typeof fakeJetStream>) => void;
  }[] = [
    { name: 'the stream already exists', init: {} },
    { name: 'the topic has no stream yet', init: { streamAbsent: true } },
    {
      name: 'the stream appears mid-wait',
      init: { streamAbsent: true },
      arm: (fake) => {
        setTimeout(() => {
          fake.state.streamAbsent = false;
        }, 100).unref?.();
      },
    },
  ];

  /**
   * The narrow half of the same guard, and the two shapes that keep it from becoming "answer every
   * failure as a quiet topic": a read whose plugin was ALREADY stopped when it was issued must still
   * be refused, and a read with no `block_ms` has no wait to swallow, so its failure is a fault on
   * both branches rather than an empty page on one. Teardown is landed INSIDE the in-flight
   * `streams.info` here — between calls it would be caught by a re-check alone.
   */
  const cutMidRequest = async (
    args: { topic: Topic; since: Cursor; blockMs?: number },
  ): Promise<string> => {
    let cut!: (err: Error) => void;
    const held = new Promise<void>((_resolve, reject) => {
      cut = reject;
    });
    const fake = fakeJetStream({ records: [], streamAbsent: true, holdInfo: held });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, TOPIC);
    const pending = plugin.fetchRecent(args);
    await new Promise((r) => setTimeout(r, 50));
    await plugin.disconnect();
    cut(new Error('connection closed while the request was on the wire'));
    return pending.then(
      (page) => JSON.stringify(page),
      (err: Error) => `rejected: ${err.message}`,
    );
  };

  it('a long-poll cut inside its in-flight stream lookup answers the empty page', async () => {
    expect(await cutMidRequest({ topic: TOPIC, since: asCursor('0'), blockMs: 30_000 })).toBe(
      JSON.stringify({ messages: [], nextCursor: '0' }),
    );
  }, 20_000);

  it('a read with no block_ms reports the same cut as the fault it is', async () => {
    expect(await cutMidRequest({ topic: TOPIC, since: asCursor('0') })).toMatch(/^rejected: /);
  }, 20_000);

  it.each([
    ['a long-poll', { topic: TOPIC, since: asCursor('0'), blockMs: 30_000 }],
    ['a plain read', { topic: TOPIC, since: asCursor('0') }],
  ] as [string, { topic: Topic; since: Cursor; blockMs?: number }][])(
    '%s issued after disconnect() is refused, never answered as a quiet topic',
    async (_name, args) => {
      const fake = fakeJetStream({ records: [], streamAbsent: true });
      const plugin = new NatsPlugin();
      injectFake(plugin, fake, TOPIC);
      await plugin.disconnect();
      await expect(plugin.fetchRecent(args)).rejects.toThrow(/not connected/);
    },
    20_000,
  );

  for (const termination of swallowed) {
    for (const state of streamStates) {
      it(`a long-poll returns an empty page when ${termination.name} and ${state.name}`, async () => {
        const fake = fakeJetStream({
          records: [],
          expiryMs: 10_000,
          throwOnClose: true,
          ...state.init,
        });
        const plugin = new NatsPlugin();
        injectFake(plugin, fake, TOPIC);
        state.arm?.(fake);

        const page = await termination.run(plugin);
        expect(page).toEqual({ messages: [], nextCursor: '0' });
        expect(fake.state.deleted).toEqual(fake.state.created);
      }, 20_000);
    }
  }
});

// Class: a read classifies a backend fault by what the server ACTUALLY answered — the status code
// AND the wording, together — and returns an empty page for the one shape that means "this topic has
// no stream". JetStream answers an absent stream 404 and an API outage 503 on the very same manager
// calls, so a classifier reading either half alone turns an outage, a de-permissioned account or a
// partition into a bridge that reports "nothing new" for as long as it lasts. Driven over the
// injection POINT as well as the shape, because the manager and the pull do not report one removal
// the same way: the manager 404s and the pull, having nobody to ask, 503s exactly as an outage does.
const errorShapes: {
  point: NonNullable<import('./fake-jetstream.js').FakeState['injectAt']>['at'];
  code?: string;
  message: string;
  outcome: 'resolved' | 'rejected';
  why: string;
}[] = [
  { point: 'streams.info', code: '404', message: 'stream not found', outcome: 'resolved', why: 'the absent topic' },
  { point: 'streams.info', code: '404', message: 'stream not found (PARLEY_leak)', outcome: 'resolved', why: 'the absent topic, named' },
  { point: 'streams.info', code: '503', message: '503', outcome: 'rejected', why: 'the JetStream API has no responder' },
  { point: 'streams.info', code: '503', message: 'no responders', outcome: 'rejected', why: 'the same outage, worded' },
  { point: 'streams.info', code: '503', message: 'stream not found', outcome: 'rejected', why: 'wording alone must not decide' },
  { point: 'streams.info', code: '404', message: 'no message found', outcome: 'rejected', why: 'a message-level 404 is not an absent stream' },
  { point: 'streams.info', message: 'stream not found', outcome: 'rejected', why: 'no status at all is not a status' },
  { point: 'streams.info', message: 'connect ECONNREFUSED 10.0.0.1:5031', outcome: 'rejected', why: 'the link, not the stream' },
  { point: 'streams.info', message: 'JetStream API 404 for topic alerts-503', outcome: 'rejected', why: 'digits in prose are not a code' },
  { point: 'consumers.add', code: '404', message: 'stream not found', outcome: 'resolved', why: 'removed between the info and the consumer' },
  { point: 'consumers.add', code: '503', message: '503', outcome: 'rejected', why: 'an outage between the info and the consumer' },
  { point: 'consumers.get', code: '404', message: 'stream not found', outcome: 'resolved', why: 'removed before the consumer is opened' },
  { point: 'consumers.get', code: '503', message: 'no responders', outcome: 'rejected', why: 'an outage before the consumer is opened' },
  { point: 'fetch', code: '404', message: 'stream not found', outcome: 'resolved', why: 'removed at the pull' },
  { point: 'fetch', code: '503', message: 'no responders', outcome: 'rejected', why: 'the pull cannot tell them apart, so the manager is asked' },
  { point: 'fetch', code: '503', message: '503', outcome: 'rejected', why: 'the same, worded as the server sends it' },
  { point: 'fetch', message: 'injected: fetch failed', outcome: 'rejected', why: 'an unrelated pull failure' },
];

describe('nats reads — an outage is not an absent topic, on every read shape', () => {
  for (const shape of readShapes) {
    for (const row of errorShapes) {
      it(`${shape.name}: ${row.code ?? 'no code'}/"${row.message}" at ${row.point} ${row.outcome} — ${row.why}`, async () => {
        const fake = fakeJetStream({
          records: [
            { seq: 1, data: payload('a') },
            { seq: 2, data: payload('b') },
            { seq: 3, data: payload('c') },
          ],
          injectAt: { at: row.point, ...(row.code === undefined ? {} : { code: row.code }), message: row.message },
        });
        const plugin = new NatsPlugin();
        injectFake(plugin, fake, TOPIC);

        const page = await plugin.fetchRecent(shape.args).then(
          (p) => p,
          () => undefined,
        );

        expect(page === undefined ? 'rejected' : 'resolved').toBe(row.outcome);
        if (page !== undefined) {
          expect(page.messages).toEqual([]);
          expect(String(page.nextCursor)).toBe(String(shape.args.since ?? '0'));
        }
        expect(fake.state.deleted).toEqual(fake.state.created);
      }, 20_000);
    }
  }

  // The pull's 503 is the shape with no answer of its own: what settles it is the manager, and this
  // pair is the only thing that keeps the settling honest — both rows inject the IDENTICAL error.
  const managerSays: { name: string; removes: boolean; outcome: 'resolved' | 'rejected' }[] = [
    { name: 'the stream is really gone', removes: true, outcome: 'resolved' },
    { name: 'the stream is still there', removes: false, outcome: 'rejected' },
  ];
  for (const verdict of managerSays) {
    it(`a 503 at the pull ${verdict.outcome} when ${verdict.name}`, async () => {
      const records = [{ seq: 1, data: payload('a') }, { seq: 2, data: payload('b') }];
      const fake = verdict.removes
        ? fakeJetStream({ records, streamMissingOn: 'fetch' })
        : fakeJetStream({ records, injectAt: { at: 'fetch', code: '503', message: 'no responders' } });
      const plugin = new NatsPlugin();
      injectFake(plugin, fake, TOPIC);
      const since = asCursor('20260101T000000000000000Z-1');

      const page = await plugin
        .fetchRecent({ topic: TOPIC, since })
        .then((p) => p, () => undefined);

      expect(page === undefined ? 'rejected' : 'resolved').toBe(verdict.outcome);
      if (page !== undefined) expect(String(page.nextCursor)).toBe(String(since));
    });
  }

  // `withStream` retries on the manager's 404 as well as on the publish's 503: `streamInfo` is a
  // MANAGER call, and only the publish surface ever reports a removal as 503.
  it('a subscribe whose stream vanished before it read the tail re-provisions it', async () => {
    const fake = fakeJetStream({ records: [], streamAbsent: true });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, TOPIC);

    await plugin.subscribe(TOPIC, () => undefined);

    expect(fake.state.addCalls).toBe(1);
    await plugin.disconnect();
  });

  // A long-poll must not spend its budget re-asking a question the server already answered with a
  // fault: counted in calls rather than milliseconds, so ten agents on one box cannot grade it.
  it('a blocking read stops asking after ONE outage answer instead of polling out its budget', async () => {
    const fake = fakeJetStream({
      records: [],
      injectAt: { at: 'streams.info', code: '503', message: '503' },
    });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, TOPIC);

    await expect(
      plugin.fetchRecent({ topic: TOPIC, since: asCursor('0'), blockMs: 2000 }),
    ).rejects.toThrow();
    expect(fake.state.infoAttempts).toBe(1);
  });

  it('a blocking read of a genuinely absent topic DOES poll for one to appear', async () => {
    const fake = fakeJetStream({ records: [], streamAbsent: true });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, TOPIC);

    const page = await plugin.fetchRecent({ topic: TOPIC, since: asCursor('0'), blockMs: 1200 });

    expect(page.messages).toEqual([]);
    expect(fake.state.infoAttempts).toBeGreaterThan(1);
  }, 20_000);
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

// Class: a page that read NOTHING must hand back the cursor it was given, on every arm that can
// produce one. An absent-topic page has no message to mint a cursor from, so the caller's own
// `since` is the only answer that keeps fetchRecent monotonic: answer with anything lower and core
// persists it, and the next catch-up replays from the bottom of the re-provisioned stream —
// a cursor that went BACKWARDS, which the protocol forbids.
//
// Crossed over every cursor SHAPE, because the regression is invisible whenever `since` happens to
// equal the bare `0` an absent page would mint anyway: that collision is exactly why the existing
// 'answers with an empty page and a cursor that replays' case could not see it. The `since` values
// below are therefore all distinguishable from `0`.
const ABSENT_SINCES = [
  { name: 'no since', since: undefined, expected: '0' },
  { name: 'a bare-decimal since', since: asCursor('500'), expected: '500' },
  {
    name: 'an incarnation-qualified since',
    since: asCursor('20260101T000000000000000Z-500'),
    expected: '20260101T000000000000000Z-500',
  },
  { name: 'a since far above any tail', since: asCursor('999999'), expected: '999999' },
];

describe('nats reads — an absent topic replays the cursor it was handed', () => {
  for (const shape of ABSENT_SINCES) {
    it(`a read of a topic with no stream and ${shape.name} answers with that cursor`, async () => {
      const fake = fakeJetStream({ records: [], streamAbsent: true });
      const plugin = new NatsPlugin();
      injectFake(plugin, fake);

      const page = await plugin.fetchRecent({ topic: PROBE, ...(shape.since ? { since: shape.since } : {}) });

      expect(page.messages).toEqual([]);
      expect(String(page.nextCursor)).toBe(shape.expected);
      expect(fake.state.addCalls).toBe(0);
    });
  }

  // The other arm into the same page: the stream was there at entry and was removed out-of-band
  // before the read finished. `since` sits below the tail on purpose, so the read genuinely reaches
  // each faulting point instead of short-circuiting on an empty window and never producing the
  // absent-topic page at all.
  for (const missingOn of ['consumers.add', 'consumers.get', 'fetch'] as const) {
    it(`a stream that vanishes at ${missingOn} mid-read still replays the caller's cursor`, async () => {
      const fake = fakeJetStream({
        records: [{ seq: 1, data: payload('a') }, { seq: 2, data: payload('b') }, { seq: 3, data: payload('c') }],
        streamMissingOn: missingOn,
      });
      const plugin = new NatsPlugin();
      injectFake(plugin, fake, TOPIC);

      const since = asCursor('20260101T000000000000000Z-1');
      const page = await plugin.fetchRecent({ topic: TOPIC, since });

      expect(page.messages).toEqual([]);
      expect(String(page.nextCursor)).toBe(String(since));
    });
  }
});
