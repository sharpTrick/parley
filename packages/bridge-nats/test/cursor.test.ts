import { asCursor, asTopic, type Cursor, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { fakeJetStream, injectFake, payload, type FakeJetStream, type FakeRecord } from './fake-jetstream.js';

// Class: a page that returned FEWER messages than its window contained must never advance the
// cursor past the messages it did not return. Core persists `nextCursor` and replays it as `since`,
// so any fabricated cursor is silent, permanent message loss. Every read shape × every degree of
// read completeness, with the incompleteness injected rather than waited for.
const TOPIC = asTopic('cursors');
const ALL = ['a', 'b', 'c', 'd', 'e'];

function makePlugin(init: Partial<FakeJetStream['state']> = {}): {
  plugin: NatsPlugin;
  fake: FakeJetStream;
} {
  const fake = fakeJetStream({
    records: ALL.map((c, i) => ({ seq: i + 1, data: payload(c) })),
    ...init,
  });
  const plugin = new NatsPlugin();
  injectFake(plugin, fake, TOPIC);
  return { plugin, fake };
}

/** Everything a healthy reader still sees when it resumes from `cursor`. */
async function replayFrom(
  plugin: NatsPlugin,
  fake: FakeJetStream,
  topic: Topic,
  cursor: Cursor,
): Promise<string[]> {
  fake.state.yieldLimit = Number.POSITIVE_INFINITY;
  fake.state.visibleTail = undefined;
  fake.state.failOn = null;
  const seen: string[] = [];
  let since = cursor;
  for (let i = 0; i < ALL.length + 2; i++) {
    const page = await plugin.fetchRecent({ topic, since });
    if (page.messages.length === 0) break;
    seen.push(...page.messages.map((m) => m.content));
    since = page.nextCursor;
  }
  return seen;
}

const completeness = [
  { read: 'complete', yieldLimit: Number.POSITIVE_INFINITY },
  { read: 'partial', yieldLimit: 2 },
  { read: 'empty', yieldLimit: 0 },
];

const shapes = [
  {
    mode: 'no-since first catch-up',
    args: (): { topic: Topic; since?: Cursor; blockMs?: number } => ({ topic: TOPIC }),
    expected: ALL,
    init: {},
  },
  {
    mode: 'since-based catch-up',
    args: () => ({ topic: TOPIC, since: asCursor('1') }),
    expected: ALL.slice(1),
    init: {},
  },
  {
    mode: 'blockMs long-poll',
    // The tail was empty at snapshot time and 'e' lands during the wait — the long-poll branch.
    args: () => ({ topic: TOPIC, since: asCursor('4'), blockMs: 1000 }),
    expected: ['e'],
    init: { visibleTail: 4 },
  },
];

describe('nats cursor integrity — a short read must not skip what it did not return', () => {
  for (const shape of shapes) {
    for (const { read, yieldLimit } of completeness) {
      it(`${shape.mode}, ${read} read: replaying nextCursor still yields every unreturned message`, async () => {
        const { plugin, fake } = makePlugin(shape.init);
        fake.state.yieldLimit = yieldLimit;

        const page = await plugin.fetchRecent(shape.args());
        const returned = page.messages.map((m) => m.content);
        const replayed = await replayFrom(plugin, fake, TOPIC, page.nextCursor);

        expect([...returned, ...replayed]).toEqual(shape.expected);
      });
    }
  }

  it('an empty page never parks the cursor at the stream tail', async () => {
    const { plugin, fake } = makePlugin();
    fake.state.yieldLimit = 0;
    const page = await plugin.fetchRecent({ topic: TOPIC });
    expect(page.messages).toHaveLength(0);
    expect(page.nextCursor).not.toBe('5');
  });

  it('a partial page resumes at the last message it actually returned', async () => {
    const { plugin, fake } = makePlugin();
    fake.state.yieldLimit = 2;
    const page = await plugin.fetchRecent({ topic: TOPIC });
    expect(page.messages.map((m) => m.content)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe(page.messages[1]!.cursor);
  });

  // The same class from the ARGUMENT side. A `limit` below 1 (or one that is not an integer) makes
  // every window this read computes empty, and an empty page still mints a cursor — one that sits at
  // the topic's tail, i.e. silent permanent loss of everything under it. So the contract is that an
  // out-of-contract argument REJECTS naming itself, before the read has created anything at all.
  // Crossed with every read shape, because each mints its cursor down a different branch. The
  // window.test.ts `positions` table is the neighbouring test that cannot reach this: its `limit`
  // is only ever undefined, 2 or 3.
  const badLimits = [
    0,
    -1,
    -100,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];

  for (const shape of shapes) {
    for (const limit of badLimits) {
      it(`${shape.mode}, limit ${limit}: rejects naming the argument and reads nothing`, async () => {
        const { plugin, fake } = makePlugin(shape.init);

        await expect(plugin.fetchRecent({ ...shape.args(), limit })).rejects.toThrow(/limit/);
        expect({ created: fake.state.created, added: fake.state.addCalls }).toEqual({
          created: [],
          added: 0,
        });
      });
    }
  }

  // The other half of the same contract: a limit that IS in contract must not be refused, and the
  // page it returns must still be lossless. Without these rows a plugin could pass every row above
  // by rejecting every read. A since-LESS page is the newest `limit` messages by definition
  // (seam.ts §6), so a truncating limit legitimately puts the older ones out of reach there and
  // nowhere else.
  const goodLimits = [1, 2, 5, 100, 2 ** 53];

  for (const shape of shapes) {
    for (const limit of goodLimits) {
      it(`${shape.mode}, limit ${limit}: the page plus its replay is still complete`, async () => {
        const { plugin, fake } = makePlugin(shape.init);
        const newestWindow = shape.args().since === undefined;

        const page = await plugin.fetchRecent({ ...shape.args(), limit });
        const returned = page.messages.map((m) => m.content);
        expect(returned.length).toBeLessThanOrEqual(limit);
        const replayed = await replayFrom(plugin, fake, TOPIC, page.nextCursor);

        expect([...returned, ...replayed]).toEqual(
          newestWindow ? shape.expected.slice(-limit) : shape.expected,
        );
      }, 20_000);
    }
  }

  // `blockMs` is a HINT the seam lets a plugin ignore, so a degenerate one is not an error — but it
  // must not become a fabricated cursor either. These rows pin the outcome the seam does demand.
  for (const blockMs of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) {
    it(`a degenerate blockMs of ${blockMs} returns the window with a cursor that replays losslessly`, async () => {
      const { plugin, fake } = makePlugin();

      const page = await plugin.fetchRecent({ topic: TOPIC, blockMs });
      const returned = page.messages.map((m) => m.content);
      const replayed = await replayFrom(plugin, fake, TOPIC, page.nextCursor);

      expect([...returned, ...replayed]).toEqual(ALL);
    });
  }

  // The same class over a link whose every round trip costs real time. A page truncated because the
  // plugin ran out of patience is indistinguishable, in the result, from a page that read its whole
  // window — so the completeness of `returned + replayed` is what has to hold at every latency.
  for (const latencyMs of [0, 250, 600]) {
    for (const shape of shapes.filter((s) => s.mode !== 'blockMs long-poll')) {
      it(`${shape.mode} over a ${latencyMs}ms link: the page plus its replay is still complete`, async () => {
        const { plugin, fake } = makePlugin({ ...shape.init, latencyMs, expiryMs: 30_000 });

        const page = await plugin.fetchRecent(shape.args());
        const returned = page.messages.map((m) => m.content);
        fake.state.latencyMs = 0;
        const replayed = await replayFrom(plugin, fake, TOPIC, page.nextCursor);

        expect([...returned, ...replayed]).toEqual(shape.expected);
        expect(returned.length).toBeGreaterThan(0);
      }, 60_000);
    }
  }
});

// The same class across a since-less page drawn from SEVERAL windows of a sparse history: a page is
// complete from its own first message, whichever window's read came up short. The histories hold a
// hole (deleted, or another subject's) wide enough that every limit between one and the topic's
// depth crosses it somewhere, so a page stitched from a short lower window under a higher one is
// reachable — and the floor keeps "returned nothing, replayed nothing" from passing.
describe('nats cursor integrity — a short read in any window of a sparse history skips nothing', () => {
  const own = (seqs: number[]): FakeRecord[] => seqs.map((seq) => ({ seq, data: payload(`m${seq}`) }));
  const foreign = (seqs: number[]): FakeRecord[] =>
    seqs.map((seq) => ({ seq, data: payload(`foreign${seq}`), subject: 'parley.someone-elses-topic' }));
  const range = (from: number, to: number): number[] =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const histories: { name: string; seqs: number[]; records: FakeRecord[] }[] = [
    { name: 'a deleted run under the tail', seqs: [...range(1, 10), 20], records: own([...range(1, 10), 20]) },
    {
      name: 'two deleted runs',
      seqs: [...range(1, 4), ...range(9, 12), 30],
      records: own([...range(1, 4), ...range(9, 12), 30]),
    },
    {
      name: 'a run of another subject under the tail',
      seqs: [...range(1, 6), 16],
      records: [...own(range(1, 6)), ...foreign(range(7, 15)), ...own([16])].sort((x, y) => x.seq - y.seq),
    },
  ];
  const shortReads = [Number.POSITIVE_INFINITY, 3, 2, 1, 0];

  for (const history of histories) {
    for (const yieldLimit of shortReads) {
      it(`${history.name}, a read that yields ${yieldLimit} per pull: every page plus its replay is a complete suffix`, async () => {
        const all = history.seqs.map((s) => `m${s}`);
        let widest = 0;
        for (let limit = 1; limit <= all.length; limit++) {
          const fake = fakeJetStream({ records: history.records, yieldLimit });
          const plugin = new NatsPlugin();
          injectFake(plugin, fake, TOPIC);

          const page = await plugin.fetchRecent({ topic: TOPIC, limit });
          widest = Math.max(widest, fake.state.created.length);
          const returned = page.messages.map((m) => m.content);
          const replayed = await replayFrom(plugin, fake, TOPIC, page.nextCursor);
          const seen = [...returned, ...replayed];

          expect(seen, `limit ${limit}`).toEqual(all.slice(all.length - seen.length));
          expect(seen.length, `limit ${limit}`).toBeGreaterThanOrEqual(limit);
        }
        expect(widest, 'no limit made the page cross the hole').toBeGreaterThanOrEqual(2);
      }, 30_000);
    }
  }
});
