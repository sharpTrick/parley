import { asCursor, asTopic, type Cursor } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { fakeJetStream, injectFake, payload, type FakeRecord } from './fake-jetstream.js';
import { seqOf } from './helpers.js';

// Class: the sequence range of a stream is NOT dense. `max_age` retention prunes the front,
// per-subject limits and message deletes punch holes, so `last_seq - since` over-counts what the
// server can actually deliver and `last_seq - limit + 1` sizes a window in SEQUENCE space that a
// COUNT was asked for. Every row therefore states the exact page the window holds — a floor as well
// as a ceiling, because "returned nothing" satisfies any ceiling — and the shapes are generated
// rather than enumerated so front, interior and TAIL holes all occur by construction. The hole at
// `last_seq` itself is the position no sequence arithmetic can see.
// Class: patience is a property of the LINK, not a constant. A pull's idle close is armed before the
// first message can arrive, so any budget shorter than one round trip closes the pull having read
// nothing and hands catch-up an empty page whose cursor never advances. The latency axis crosses
// every read shape, and every cell demands the whole window rather than merely a prompt return.
const TOPIC = asTopic('window');
const STREAM = 'PARLEY_window';
const OWN = 'parley.topic'; // the fake's default record subject
const FOREIGN_SUBJECT = 'parley.someone-elses-topic';
const EXPIRY_MS = 6000;

const stream = (seqs: number[]): FakeRecord[] =>
  seqs.map((seq) => ({ seq, data: payload(`m${seq}`) }));

/** `tail`: what the server reports as `last_seq`, which a deleted tail message leaves above the data. */
interface Shape {
  name: string;
  seqs: number[];
  tail?: number;
}

interface Position {
  name: string;
  since?: string;
  limit?: number;
}

const mulberry32 = (seed: number): (() => number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * A pseudo-random subset of 1..span whose reported `last_seq` stays `span`. `tailHole` decides
 * whether `span` itself survives — left to chance it lands on one side or the other and the position
 * that matters most stops being covered.
 */
const sparse = (seed: number, tailHole: boolean, span = 12): Shape => {
  const rnd = mulberry32(seed);
  const kept = Array.from({ length: span }, (_, i) => i + 1)
    .filter(() => rnd() < 0.6)
    .filter((s) => s !== span);
  const seqs = tailHole ? kept : [...kept, span];
  return {
    name: `generated #${seed} ${tailHole ? 'with a hole at last_seq' : 'reaching last_seq'} [${seqs.join(',')}] of ${span}`,
    seqs,
    tail: span,
  };
};

const shapes: Shape[] = [
  { name: 'dense stream', seqs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  { name: 'front pruned by max_age', seqs: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
  { name: 'front pruned and interior holes', seqs: [11, 12, 15, 16, 20] },
  { name: 'interior holes only', seqs: [1, 4, 5, 9, 10] },
  { name: 'single message far from seq 1', seqs: [500] },
  { name: 'everything pruned', seqs: [] },
  { name: 'last_seq names a deleted message', seqs: [1, 2], tail: 3 },
  { name: 'only message deleted, last_seq left behind', seqs: [], tail: 4 },
  { name: 'the newest messages deleted, history left behind', seqs: [1, 2, 3, 4], tail: 12 },
  { name: 'a deleted tail longer than any widening budget', seqs: [1, 2, 3, 4], tail: 1000 },
  ...[1, 2].flatMap((seed) => [sparse(seed, true), sparse(seed, false)]),
];

const positions: Position[] = [
  { name: 'no since' },
  { name: 'no since, small limit', limit: 2 },
  { name: 'since 0 — before first_seq', since: '0' },
  { name: 'since 5 — may predate first_seq', since: '5' },
  { name: 'since 15 — inside the live window', since: '15' },
  { name: 'since 0, small limit', since: '0', limit: 3 },
];

/**
 * The exact page the shape owes this position. A `since` above the reported `last_seq` names a
 * sequence the stream never had, so the read falls back to the newest window; anything else is the
 * next `limit` messages strictly after `since`. Computed from the shape rather than bounded, so a
 * page that returns FEWER than the window holds — up to and including nothing — fails.
 */
const owed = (shape: Shape, pos: Position): number[] => {
  const limit = pos.limit ?? 100;
  const lastSeq = shape.tail ?? shape.seqs.at(-1) ?? 0;
  const since = pos.since === undefined ? undefined : Number(pos.since);
  if (since !== undefined && since <= lastSeq) {
    return shape.seqs.filter((s) => s > since).slice(0, limit);
  }
  return shape.seqs.slice(-Math.min(limit, shape.seqs.length));
};

const argsFor = (pos: Position): { topic: typeof TOPIC; since?: Cursor; limit?: number } => ({
  topic: TOPIC,
  ...(pos.since === undefined ? {} : { since: asCursor(pos.since) }),
  ...(pos.limit === undefined ? {} : { limit: pos.limit }),
});

describe('nats fetch window — a sparse range must not burn the pull expiry', () => {
  for (const shape of shapes) {
    for (const pos of positions) {
      it(`${shape.name}, ${pos.name}: returns promptly and returns the whole window`, async () => {
        const fake = fakeJetStream({
          records: stream(shape.seqs),
          expiryMs: EXPIRY_MS,
          ...(shape.tail === undefined ? {} : { visibleTail: shape.tail }),
        });
        const plugin = new NatsPlugin();
        injectFake(plugin, fake, TOPIC);

        const started = Date.now();
        const page = await plugin.fetchRecent(argsFor(pos));
        const elapsed = Date.now() - started;

        expect(elapsed).toBeLessThan(EXPIRY_MS / 2);
        const seqs = page.messages.map((m) => seqOf(m.cursor));
        expect(seqs).toEqual(owed(shape, pos));
        if (page.messages.length > 0) expect(page.nextCursor).toBe(page.messages.at(-1)?.cursor);
      });
    }
  }

  it('an empty read from a long-dead cursor resumes at the retained window, not inside the gap', async () => {
    const fake = fakeJetStream({ records: stream([11, 12, 13]), yieldLimit: 0 });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, TOPIC);

    const page = await plugin.fetchRecent({ topic: TOPIC, since: asCursor('2') });

    expect(page.messages).toHaveLength(0);
    expect(seqOf(page.nextCursor)).toBe(10);

    fake.state.yieldLimit = Number.POSITIVE_INFINITY;
    const resumed = await plugin.fetchRecent({ topic: TOPIC, since: page.nextCursor });
    expect(resumed.messages.map((m) => m.content)).toEqual(['m11', 'm12', 'm13']);
  });

  it('draining a pruned stream from a long-dead cursor still yields every retained message', async () => {
    const fake = fakeJetStream({ records: stream([11, 12, 15, 16, 20]), expiryMs: EXPIRY_MS });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, TOPIC);

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

// Class: every counter in `streams.info().state` describes the STREAM, and a stream may capture
// more subjects than one topic's — `ensureStream` accepts a pre-existing `pw.>` stream, and the
// operator who created it publishes to it. `last_seq`, `first_seq`, `messages` and `num_deleted`
// then measure a foreign publisher as much as this topic, so a window anchored on any of them can
// be pushed clean off the topic's own history. `num_deleted` stays 0 throughout, which is why a
// per-subject repair gated on deletions is no repair at all, and the deepest tail here is past the
// widening budget so a page that merely widens harder cannot pass either.
describe('nats fetch window — a stream-wide counter never stands in for the topic', () => {
  const LIMIT = 5;
  const depths = [1, 20, 400]; // 400 > LIMIT * 2^WIDEN_ATTEMPTS, so widening cannot reach the topic
  const foreignShapes: Shape[] = [
    { name: 'dense topic history', seqs: [1, 2, 3] },
    { name: 'topic history with holes', seqs: [1, 4, 7] },
    { name: 'a single topic message', seqs: [3] },
  ];
  const foreignPositions: Position[] = [
    { name: 'no since', limit: LIMIT },
    { name: 'since 0', since: '0', limit: LIMIT },
    { name: 'since 2', since: '2', limit: LIMIT },
  ];

  /**
   * The topic's messages sparse inside a stream another publisher fills — its gaps and its `depth`
   * newest sequences are that publisher's. Nothing is deleted, so `num_deleted` stays 0 and the
   * whole range is the foreign publisher's to move.
   */
  const withForeignTail = (seqs: number[], depth: number): FakeRecord[] => {
    const top = seqs.at(-1) ?? 0;
    const own = new Set(seqs);
    const foreign = (seq: number): FakeRecord => ({
      seq,
      data: payload(`foreign${seq}`),
      subject: FOREIGN_SUBJECT,
    });
    return [
      ...stream(seqs),
      ...Array.from({ length: top }, (_, i) => i + 1).filter((s) => !own.has(s)).map(foreign),
      ...Array.from({ length: depth }, (_, i) => foreign(top + i + 1)),
    ].sort((a, b) => a.seq - b.seq);
  };

  for (const depth of depths) {
    for (const shape of foreignShapes) {
      for (const pos of foreignPositions) {
        it(`${depth} foreign message(s) above ${shape.name}, ${pos.name}: the page holds the topic's own`, async () => {
          const read = async (
            foreignDepth: number,
          ): Promise<{ seqs: number[]; contents: string[]; cursor: string; pulls: number }> => {
            const fake = fakeJetStream({
              records: withForeignTail(shape.seqs, foreignDepth),
              expiryMs: EXPIRY_MS,
            });
            const plugin = new NatsPlugin();
            injectFake(plugin, fake, TOPIC);
            const page = await plugin.fetchRecent(argsFor(pos));
            return {
              seqs: page.messages.map((m) => seqOf(m.cursor)),
              contents: page.messages.map((m) => m.content),
              cursor: String(page.nextCursor),
              pulls: fake.state.created.length,
            };
          };

          const expected = owed({ ...shape, tail: (shape.seqs.at(-1) ?? 0) + depth }, pos);
          const page = await read(depth);
          expect(page.seqs).toEqual(expected);
          expect(page.contents).toEqual(expected.map((s) => `m${s}`));
          expect(seqOf(page.cursor)).toBe(expected.at(-1));
          // The page alone does not say what it cost. The same topic without the foreign tail is
          // the same read: an anchor that follows the foreign publisher's sequences instead pays
          // extra pulls scanning back over messages it will never be shown.
          expect(page.pulls).toBe((await read(0)).pulls);
        }, 30_000);
      }
    }
  }

  it('reports a foreign tail the way JetStream does: nothing deleted, the stream longer than the topic', async () => {
    const fake = fakeJetStream({ records: withForeignTail([1, 4, 7], 400) });
    const jsm = fake.jsm as {
      streams: {
        info: () => Promise<{ state: { messages: number; first_seq: number; last_seq: number; num_deleted: number } }>;
      };
    };

    const info = await jsm.streams.info();

    expect(info.state.num_deleted).toBe(0);
    expect(info.state.messages).toBe(407);
    expect(info.state.first_seq).toBe(1);
    expect(info.state.last_seq).toBe(407);
  });

  it('a cold start over a foreign tail names the topic tail, and draining from 0 loses nothing', async () => {
    const fake = fakeJetStream({ records: withForeignTail([1, 2, 3, 4, 5], 400), expiryMs: EXPIRY_MS });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, TOPIC);

    const cold = await plugin.fetchRecent({ topic: TOPIC, limit: 2 });
    expect(cold.messages.map((m) => m.content)).toEqual(['m4', 'm5']);
    expect(seqOf(cold.nextCursor)).toBe(5);

    const seen: string[] = [];
    let since: Cursor = asCursor('0');
    for (let i = 0; i < 8; i++) {
      const page = await plugin.fetchRecent({ topic: TOPIC, since, limit: 2 });
      if (page.messages.length === 0) break;
      seen.push(...page.messages.map((m) => m.content));
      expect(page.nextCursor).not.toBe(since);
      since = page.nextCursor;
    }

    expect(seen).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  }, 30_000);
});

// A pull is closed the moment its budget expires, so every assertion above about a short read is
// only worth what the fake's `close()` is worth. nats.js `stop()` unsubscribes and ends the
// iterator, discarding whatever had not reached the client — a fake that drains its window on close
// grades semantics the driver does not have, and every idle-close row passes vacuously.
describe('nats pull fake fidelity — closing a pull loses what it had not delivered', () => {
  const held = [1, 2, 3, 4, 5];

  it('a pull closed mid-window yields strictly fewer messages than the window holds', async () => {
    const fake = fakeJetStream({ records: stream(held), latencyMs: 60 });
    const consumer = await (
      fake.js as { consumers: { get: () => Promise<{ fetch: (o: { max_messages: number }) => Promise<AsyncIterable<{ seq: number }> & { close: () => void }> }> } }
    ).consumers.get();
    const pull = await consumer.fetch({ max_messages: held.length });

    const seen: number[] = [];
    setTimeout(() => pull.close(), 150);
    for await (const m of pull) seen.push(m.seq);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(held.length);
  }, 10_000);

  // The other half of the same fidelity: the per-subject tail read the window arithmetic prefers is
  // NOT always available. A fake that answers it from the surviving records grades an anchor the
  // server refuses to supply, and the widening the server actually leaves this read to goes ungraded.
  it('answers last_by_subj the way NATS 2.10 does — a deleted newest message is not found', async () => {
    const streams = (records: FakeRecord[], visibleTail?: number): {
      getMessage: (s: string, r: { last_by_subj?: string }) => Promise<{ seq: number }>;
    } =>
      (
        fakeJetStream({ records, ...(visibleTail === undefined ? {} : { visibleTail }) }).jsm as {
          streams: { getMessage: (s: string, r: { last_by_subj?: string }) => Promise<{ seq: number }> };
        }
      ).streams;

    await expect(streams(stream(held)).getMessage(STREAM, { last_by_subj: OWN })).resolves.toMatchObject({
      seq: 5,
    });
    await expect(streams(stream(held), 5).getMessage(STREAM, { last_by_subj: OWN })).resolves.toMatchObject({
      seq: 5,
    });
    await expect(streams(stream(held), 9).getMessage(STREAM, { last_by_subj: OWN })).rejects.toThrow(
      /no message found/,
    );
    // …and it answers from the SUBJECT it was handed, not from whatever the stream holds.
    await expect(streams(stream(held)).getMessage(STREAM, { last_by_subj: FOREIGN_SUBJECT })).rejects.toThrow(
      /no message found/,
    );
  });

  // Class: the fake answers from a shortcut instead of from the request. Every foreign-publisher row
  // above certifies that a read sees only its own subject — but only if the fake's consumer decides
  // that from the `filter_subject` it was HANDED. The same holds for `opt_start_seq` and
  // `max_messages`: a fake that ignores any of them grades a request the plugin never made.
  describe('the fake consumer answers from its own config', () => {
    const mixed: FakeRecord[] = [
      { seq: 1, data: payload('own1') },
      { seq: 2, data: payload('other'), subject: FOREIGN_SUBJECT },
      { seq: 3, data: payload('own3') },
      { seq: 4, data: payload('deeper'), subject: `${OWN}.deeper` },
      { seq: 5, data: payload('own5') },
    ];

    const pullWith = async (
      cfg: { filter_subject?: string; opt_start_seq?: number },
      max_messages: number,
    ): Promise<number[]> => {
      const fake = fakeJetStream({ records: mixed });
      const jsm = fake.jsm as { consumers: { add: (s: string, c: unknown) => Promise<{ name: string }> } };
      await jsm.consumers.add(STREAM, cfg);
      const consumer = await (
        fake.js as { consumers: { get: () => Promise<{ fetch: (o: { max_messages: number }) => Promise<AsyncIterable<{ seq: number }>> }> } }
      ).consumers.get();
      const seen: number[] = [];
      for await (const m of await consumer.fetch({ max_messages })) seen.push(m.seq);
      return seen;
    };

    const rows: { name: string; cfg: { filter_subject?: string; opt_start_seq?: number }; max: number; seqs: number[] }[] = [
      { name: 'honours filter_subject', cfg: { filter_subject: OWN, opt_start_seq: 1 }, max: 10, seqs: [1, 3, 5] },
      { name: 'a sibling subject is a different consumer', cfg: { filter_subject: FOREIGN_SUBJECT, opt_start_seq: 1 }, max: 10, seqs: [2] },
      { name: 'a deeper subject is not the topic', cfg: { filter_subject: `${OWN}.deeper`, opt_start_seq: 1 }, max: 10, seqs: [4] },
      { name: 'a wildcard filter takes one token', cfg: { filter_subject: 'parley.*', opt_start_seq: 1 }, max: 10, seqs: [1, 2, 3, 5] },
      { name: 'NO filter sees the whole stream, as the server would show it', cfg: { opt_start_seq: 1 }, max: 10, seqs: [1, 2, 3, 4, 5] },
      { name: 'honours opt_start_seq', cfg: { filter_subject: OWN, opt_start_seq: 3 }, max: 10, seqs: [3, 5] },
      { name: 'honours max_messages', cfg: { filter_subject: OWN, opt_start_seq: 1 }, max: 2, seqs: [1, 3] },
    ];

    for (const row of rows) {
      it(row.name, async () => {
        expect(await pullWith(row.cfg, row.max)).toEqual(row.seqs);
      });
    }
  });

  it('an unclosed pull yields its whole window', async () => {
    const fake = fakeJetStream({ records: stream(held), latencyMs: 5 });
    const consumer = await (
      fake.js as { consumers: { get: () => Promise<{ fetch: (o: { max_messages: number }) => Promise<AsyncIterable<{ seq: number }>> }> } }
    ).consumers.get();
    const pull = await consumer.fetch({ max_messages: held.length });

    const seen: number[] = [];
    for await (const m of pull) seen.push(m.seq);

    expect(seen).toEqual(held);
  }, 10_000);
});

// The read shapes that matter most on a slow link: a dense window, a window with holes, and a
// window whose top sequence is a hole. `expiryMs` is far above every budget below, so nothing but
// the plugin's own patience can end these pulls.
describe('nats fetch window — patience scales with the link, not with a constant', () => {
  const latencies = [0, 50, 250];
  const linkShapes: Shape[] = [
    { name: 'dense', seqs: [1, 2, 3] },
    { name: 'interior holes', seqs: [1, 4, 5] },
    { name: 'a hole at last_seq', seqs: [1, 2, 3], tail: 6 },
  ];
  const linkPositions: Position[] = [
    { name: 'no since' },
    { name: 'since 0', since: '0' },
    { name: 'no since, limit 2', limit: 2 },
  ];

  for (const latency of latencies) {
    for (const shape of linkShapes) {
      for (const pos of linkPositions) {
        it(`${latency}ms per round trip, ${shape.name}, ${pos.name}: the page still holds the whole window`, async () => {
          const fake = fakeJetStream({
            records: stream(shape.seqs),
            latencyMs: latency,
            expiryMs: 30_000,
            ...(shape.tail === undefined ? {} : { visibleTail: shape.tail }),
          });
          const plugin = new NatsPlugin();
          injectFake(plugin, fake, TOPIC);

          const page = await plugin.fetchRecent(argsFor(pos));

          expect(page.messages.map((m) => seqOf(m.cursor))).toEqual(owed(shape, pos));
          expect(page.nextCursor).toBe(page.messages.at(-1)?.cursor);
        }, 30_000);
      }
    }
  }

  // The other half of the same budget: a pull the server truncates and then holds open must be ended
  // by the plugin, not waited out. Without a per-pull idle close the read blocks for the whole
  // `expires` on every page — and `expires` now scales with the link, so it is not even a fixed cost.
  const truncated: Position[] = [
    { name: 'no since' },
    { name: 'since 0', since: '0' },
    { name: 'since 1', since: '1' },
  ];
  for (const pos of truncated) {
    it(`a pull truncated mid-window, ${pos.name}: returns without waiting out the pull expiry`, async () => {
      const fake = fakeJetStream({
        records: stream([1, 2, 3, 4, 5]),
        yieldLimit: 2,
        expiryMs: 20_000,
      });
      const plugin = new NatsPlugin();
      injectFake(plugin, fake, TOPIC);

      const started = Date.now();
      const page = await plugin.fetchRecent(argsFor(pos));
      const elapsed = Date.now() - started;

      expect(page.messages).toHaveLength(2);
      expect(elapsed).toBeLessThan(2000);
      expect(page.nextCursor).toBe(page.messages.at(-1)?.cursor);
    }, 40_000);
  }

  it('a slow link never returns an empty page whose cursor fails to advance', async () => {
    const fake = fakeJetStream({
      records: stream([1, 2, 3]),
      latencyMs: 300,
      expiryMs: 30_000,
    });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, TOPIC);

    let since: Cursor = asCursor('0');
    const seen: string[] = [];
    for (let page = 0; page < 4; page++) {
      const result = await plugin.fetchRecent({ topic: TOPIC, since, limit: 1 });
      if (result.messages.length === 0) break;
      seen.push(...result.messages.map((m) => m.content));
      expect(result.nextCursor).not.toBe(since);
      since = result.nextCursor;
    }

    expect(seen).toEqual(['m1', 'm2', 'm3']);
  }, 60_000);
});

// Class: work proportional to the HISTORY rather than to `limit`. Every row above states the page a
// read returns and none of them states what the read cost, so a page that is correct because it
// materialised the whole topic and threw all but `limit` away passes them all — and core's cold
// start is exactly that read. The bound is asserted on what the fake was ASKED for and on what it
// actually handed over, because the page cannot show either. Depth is crossed with the depth of the
// hole above the topic tail: the cost may follow the hole, never the history.
describe('nats fetch window — a page costs what the page holds, not what the topic holds', () => {
  const LIMIT = 5;

  /** `depth` topic messages, then `hole` sequences the topic no longer has above them. */
  const deepHistory = (depth: number, hole: number): { records: FakeRecord[]; tail: number } => ({
    records: stream(Array.from({ length: depth }, (_, i) => i + 1)),
    tail: depth + hole,
  });

  // `LIMIT + 1` is the row where a window OVERSHOOTS: the first window holds nothing, and the wider
  // one that follows covers far more of the topic than the page may return.
  for (const depth of [10, 500, 5000]) {
    for (const hole of [LIMIT, LIMIT + 1, 4 * LIMIT]) {
      it(`${depth} messages under a ${hole}-deep hole: the read scales with the hole, not the depth`, async () => {
        const { records, tail } = deepHistory(depth, hole);
        const fake = fakeJetStream({ records, visibleTail: tail, expiryMs: EXPIRY_MS });
        const plugin = new NatsPlugin();
        injectFake(plugin, fake, TOPIC);

        const page = await plugin.fetchRecent({ topic: TOPIC, limit: LIMIT });

        expect(page.messages.map((m) => m.content)).toEqual(
          Array.from({ length: LIMIT }, (_, i) => `m${depth - LIMIT + i + 1}`),
        );
        // A budget that admits the deepest history here would be met by reading all of it.
        const budget = 8 * (hole + LIMIT);
        expect(fake.state.yielded).toBeLessThanOrEqual(budget);
        expect(Math.max(...fake.state.maxMessages)).toBeLessThanOrEqual(budget);
      }, 60_000);
    }
  }

  // The same bound from the other side: a pull STOPS at the tail it was given. Without that stop a
  // page is ended only by the idle close, so the cost above is held up by a timer rather than by the
  // read knowing where its window ends.
  it('a pull stops at the topic tail instead of being ended by the idle close', async () => {
    const fake = fakeJetStream({
      records: stream(Array.from({ length: 40 }, (_, i) => i + 1)),
      expiryMs: EXPIRY_MS,
    });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, TOPIC);

    const started = Date.now();
    const page = await plugin.fetchRecent({ topic: TOPIC, since: asCursor('0'), limit: 100 });

    expect(page.messages).toHaveLength(40);
    expect(fake.state.yielded).toBe(40);
    // 200ms is the idle close; a read that ran to the tail never arms it to completion.
    expect(Date.now() - started).toBeLessThan(200);
  }, 20_000);
});
