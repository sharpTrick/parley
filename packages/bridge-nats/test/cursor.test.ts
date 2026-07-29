import { asCursor, asTopic, type Cursor, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { fakeJetStream, injectFake, payload, type FakeJetStream } from './fake-jetstream.js';

// Class: a page that returned FEWER messages than its window contained must never advance the
// cursor past the messages it did not return. Core persists `nextCursor` and replays it as `since`,
// so any fabricated cursor is silent, permanent message loss. Every read shape × every degree of
// read completeness, with the incompleteness injected rather than waited for.
const TOPIC = asTopic('cursors');
const STREAM = 'PARLEY_cursors';
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
  injectFake(plugin, fake, STREAM);
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
    expect(page.nextCursor).toBe(page.messages[1].cursor);
  });
});
