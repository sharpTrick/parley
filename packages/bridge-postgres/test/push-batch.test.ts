import { asHandle, asTopic, type Message, type Topic } from '@sharptrick/parley-core';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';

// The push path's drain is a loop: read at most DRAIN_BATCH rows strictly after `lastSeen`, in
// ascending seq order, deliver them, repeat until empty. Every one of those three clauses is a
// delivery guarantee — ordering, at-most-once, and completeness — and against a hand-rolled fake
// they are all supplied for free by whatever the fake decides to hand back. So these drive the loop
// against a real server, at and around the batch boundary, with the rows arriving the three ways a
// deployment produces them: one bulk commit, N concurrent posts, and a second commit landing while
// the first is still draining.

const PG_URL = process.env.PARLEY_PG_URL ?? 'postgres://parley:parley@127.0.0.1:5432/parley';
const DRAIN_BATCH = 512;
const rand = (): string => Math.random().toString(36).slice(2, 8);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function isUp(url: string): Promise<boolean> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 800 });
  c.on('error', () => undefined);
  try {
    await c.connect();
    await c.query('SELECT 1');
    await c.end();
    return true;
  } catch {
    await c.end().catch(() => undefined);
    return false;
  }
}

async function dropTable(table: string): Promise<void> {
  const admin = new Client({ connectionString: PG_URL });
  admin.on('error', () => undefined);
  await admin.connect();
  await admin.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  await admin.query(`DROP TABLE IF EXISTS "${table}_senders" CASCADE`);
  await admin.query(`DROP FUNCTION IF EXISTS "${table}_notify"() CASCADE`);
  await admin.end();
}

/** One transaction, `count` rows — the shape that makes a drain batch bigger than one row. */
async function bulkCommit(table: string, topic: string, from: number, count: number): Promise<void> {
  const admin = new Client({ connectionString: PG_URL });
  admin.on('error', () => undefined);
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO "${table}" (topic, sender, content, ts, in_reply_to)
       SELECT $1, 'u', 'm' || g, $2, NULL FROM generate_series($3::int, $4::int) g`,
      [topic, new Date().toISOString(), from, from + count - 1],
    );
  } finally {
    await admin.end();
  }
}

type Arrival = 'bulk' | 'posts' | 'split';

interface Cell {
  count: number;
  arrival: Arrival;
}

const CELLS: Cell[] = [
  ...[1, 2, DRAIN_BATCH - 1, DRAIN_BATCH, DRAIN_BATCH + 1, 3 * DRAIN_BATCH].map(
    (count): Cell => ({ count, arrival: 'bulk' }),
  ),
  ...[1, 2, DRAIN_BATCH + 1].map((count): Cell => ({ count, arrival: 'posts' })),
  ...[2, DRAIN_BATCH + 1, 2 * DRAIN_BATCH].map((count): Cell => ({ count, arrival: 'split' })),
];

if (await isUp(PG_URL)) {
  describe('push drains a real batch completely, in order, exactly once', () => {
    it.each(CELLS.map((c) => [`${c.count} row(s) arriving as ${c.arrival}`, c] as const))(
      '%s',
      async (_label, cell) => {
        const table = `parley_push_${rand()}`;
        const topic: Topic = asTopic(`push-${rand()}`);

        const plugin = new PostgresPlugin();
        await plugin.connect({ url: PG_URL, table_name: table });
        const writer = new PostgresPlugin();
        await writer.connect({ url: PG_URL, table_name: table });

        try {
          const got: Message[] = [];
          await plugin.subscribe(topic, (m) => got.push(m));

          if (cell.arrival === 'bulk') {
            await bulkCommit(table, topic, 0, cell.count);
          } else if (cell.arrival === 'posts') {
            await Promise.all(
              Array.from({ length: cell.count }, (_, i) =>
                writer.post(topic, asHandle('u'), `m${i}`),
              ),
            );
          } else {
            const half = Math.floor(cell.count / 2);
            await bulkCommit(table, topic, 0, half);
            await bulkCommit(table, topic, half, cell.count - half);
          }

          const deadline = Date.now() + 30000;
          while (got.length < cell.count && Date.now() < deadline) await sleep(25);
          // Give a mis-ordered or duplicating drain room to overshoot rather than reading the
          // count the instant it is first satisfied.
          await sleep(250);

          expect(got.length, 'delivered count').toBe(cell.count);
          const seqs = got.map((m) => Number(m.backendMsgId));
          expect(
            seqs.every((s, i) => i === 0 || s > (seqs[i - 1] as number)),
            'deliveries are not strictly ascending by cursor',
          ).toBe(true);
          expect(new Set(seqs).size, 'duplicate delivery').toBe(seqs.length);
          if (cell.arrival !== 'posts') {
            expect(got.map((m) => m.content)).toEqual(
              Array.from({ length: cell.count }, (_, i) => `m${i}`),
            );
          }
        } finally {
          await plugin.disconnect();
          await writer.disconnect();
          await dropTable(table);
        }
      },
      90000,
    );
  });
} else {
  describe.skip(`push batch drain (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
