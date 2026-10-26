import { asCursor, asTopic, type Topic } from '@sharptrick/parley-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { channelFor } from '../src/schema.js';
import { servePool } from './fake-pg.js';
import { sleep } from './pg-harness.js';

// Every read in this plugin projects `seq::text AS seq` and sorts by `<table>.seq`. Drop the table
// qualification and PostgreSQL binds `ORDER BY seq` to that OUTPUT alias instead of the bigint
// column, sorting lexicographically — and lexicographic order is not a reordering, it is message
// LOSS: with seqs 9,10,11 above a cursor, an ASC page of one returns '10', the cursor advances to
// 10, and 9 is durably stored and permanently unreachable.
//
// The real-server suites do catch it, but only where a topic's seq values happen to straddle a
// digit-length boundary, and they need a server. So this grades the property directly and without
// one, over ranges chosen so lexicographic and numeric order DISAGREE, across every read shape.

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  clients: [] as { emit: (event: string, arg?: unknown) => void }[],
}));

vi.mock('pg', async () => {
  const { FakeEmitter, fakePool, servePool: serve } = await import('./fake-pg.js');

  class MockClient extends FakeEmitter {
    constructor() {
      super();
      state.clients.push(this);
    }
    async connect(): Promise<void> {}
    async query(): Promise<{ rows: unknown[] }> {
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }

  return {
    Pool: vi.fn(() => fakePool(async (sql, values) => ({ rows: serve(state.rows, sql, values) ?? [] }))),
    Client: MockClient,
  };
});

const URL = 'postgres://app:s3cret@db.example.com:5432/prod';

function seed(topic: Topic, seqs: readonly number[]): void {
  state.rows = seqs.map((seq) => ({
    seq: String(seq),
    topic: String(topic),
    sender: 'u',
    content: `m${seq}`,
    ts: new Date().toISOString(),
    in_reply_to: null,
  }));
}

/** Ranges where lexicographic and numeric order disagree — the only place the trap is visible. */
const RANGES = [
  { label: 'seqs 8..12', seqs: [8, 9, 10, 11, 12] },
  { label: 'seqs 98..102', seqs: [98, 99, 100, 101, 102] },
  { label: 'seqs 998..1002', seqs: [998, 999, 1000, 1001, 1002] },
] as const;

type Shape = 'since-less newest page' | 'exclusive-since page' | 'drain';
const SHAPES: Shape[] = ['since-less newest page', 'exclusive-since page', 'drain'];

const CELLS = RANGES.flatMap((range) => SHAPES.map((shape) => ({ range, shape })));

beforeEach(() => {
  state.rows = [];
  state.clients = [];
});

describe('every read orders by the bigint seq, not by its text projection', () => {
  it.each(CELLS.map((c) => [`${c.shape}, ${c.range.label}`, c] as const))(
    '%s',
    async (_label, cell) => {
      const topic = asTopic('ordering');
      const plugin = new PostgresPlugin();
      await plugin.connect({ url: URL, table_name: 'parley_ord' });
      try {
        const { seqs } = cell.range;
        if (cell.shape === 'since-less newest page') {
          seed(topic, seqs);
          const page = await plugin.fetchRecent({ topic, limit: 3 });
          expect(page.messages.map((m) => m.content)).toEqual(
            seqs.slice(-3).map((s) => `m${s}`),
          );
          expect(String(page.nextCursor)).toBe(String(seqs.at(-1)));
        } else if (cell.shape === 'exclusive-since page') {
          seed(topic, seqs);
          const first = seqs[0] as number;
          const page = await plugin.fetchRecent({
            topic,
            since: asCursor(String(first)),
            limit: 2,
          });
          expect(page.messages.map((m) => m.content)).toEqual([
            `m${first + 1}`,
            `m${first + 2}`,
          ]);
        } else {
          const got: string[] = [];
          await plugin.subscribe(topic, (m) => got.push(m.content));
          seed(topic, seqs);
          for (const c of state.clients) c.emit('notification', { channel: channelFor(topic) });
          const deadline = Date.now() + 2000;
          while (got.length < seqs.length && Date.now() < deadline) await sleep(5);
          expect(got, 'push re-delivered or reordered rows').toEqual(seqs.map((s) => `m${s}`));
        }
      } finally {
        await plugin.disconnect();
      }
    },
    20000,
  );
});

// The fake is only evidence while it still models the server. Serving a read it cannot classify in
// some default order is how a rewritten query keeps a suite green that has stopped grading it, so
// the refusal is asserted rather than assumed.
describe('the fake refuses to guess how an unrecognised read would sort', () => {
  const ROW = [{ seq: '1' }];
  const UNCLASSIFIABLE = [
    'SELECT seq::text AS seq, topic FROM "t" WHERE topic = $1 LIMIT $2',
    'SELECT seq::text AS seq, topic FROM "t" WHERE topic = $1 ORDER BY ts DESC LIMIT $2',
    'SELECT seq::text AS seq, topic FROM "t" WHERE topic = $1 ORDER BY 1 DESC LIMIT $2',
  ];

  it.each(UNCLASSIFIABLE)('throws instead of serving: %s', (sql) => {
    expect(() => servePool(ROW, sql, ['t', 10])).toThrow(/fake-pg/);
  });

  it('a read with no LIMIT is an error, not an unbounded page', () => {
    expect(() =>
      servePool(ROW, 'SELECT seq::text AS seq, topic FROM "t" WHERE topic = $1 ORDER BY "t".seq ASC', [
        't',
      ]),
    ).toThrow(/LIMIT/);
  });

  it('a bare ORDER BY seq sorts the way the server would — on the text alias', () => {
    const rows = [{ seq: '9' }, { seq: '10' }];
    const bare = 'SELECT seq::text AS seq, topic FROM "t" WHERE topic = $1 ORDER BY seq ASC LIMIT 5';
    const qualified =
      'SELECT seq::text AS seq, topic FROM "t" WHERE topic = $1 ORDER BY "t".seq ASC LIMIT 5';
    expect(servePool(rows, bare, ['t'])?.map((r) => r['seq'])).toEqual(['10', '9']);
    expect(servePool(rows, qualified, ['t'])?.map((r) => r['seq'])).toEqual(['9', '10']);
  });
});
