import { asCursor, asHandle, asTopic, type Cursor, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { dropTable, isUp, PG_URL, rand, sleep } from './pg-harness.js';

// BIGSERIAL assigns `seq` at INSERT time, not COMMIT time, so two writers can make seq 42 visible
// while 41 is still uncommitted. A reader that advances its cursor to 42 in that window can never
// fetch 41 again: the message is durably stored and permanently unreachable. post()'s per-topic
// advisory lock is the only thing that closes it.
//
// The conformance suite's concurrentPost check cannot see this — it reads the topic only after
// every writer has settled, when the gap has long since filled in. The hazard exists exclusively
// while writes are IN FLIGHT, so these cases put a reader there: it fetches from its own
// nextCursor, concurrently with the writers, and the union of what it saw must equal the final
// history exactly. Any store backend that mints a cursor from a pre-commit sequence can
// reintroduce this, so the shape is the assertion, not the SQL.

interface Cell {
  writers: number;
  perWriter: number;
  readerPollMs: number;
}

const CELLS: Cell[] = [
  { writers: 6, perWriter: 30, readerPollMs: 0 },
  { writers: 4, perWriter: 40, readerPollMs: 2 },
  { writers: 3, perWriter: 60, readerPollMs: 10 },
];

if (await isUp(PG_URL)) {
  describe('a reader interleaved WITH concurrent writers loses no message', () => {
    it.each(
      CELLS.map(
        (c) =>
          [
            `${c.writers} writer(s) x ${c.perWriter}, reader polling every ${c.readerPollMs}ms`,
            c,
          ] as const,
      ),
    )('%s', async (_label, cell) => {
      const table = `parley_loss_${rand()}`;
      const topic: Topic = asTopic(`loss-${rand()}`);
      const expected = cell.writers * cell.perWriter;

      const reader = new PostgresPlugin();
      await reader.connect({ url: PG_URL, table_name: table });
      const writers = await Promise.all(
        Array.from({ length: cell.writers }, async () => {
          const p = new PostgresPlugin();
          await p.connect({ url: PG_URL, table_name: table });
          return p;
        }),
      );

      try {
        const seen: string[] = [];
        let cursor: Cursor = asCursor('0');
        let writing = true;

        const readLoop = (async () => {
          for (;;) {
            // Sample `writing` BEFORE the fetch, so that an empty page taken while a writer was
            // still in flight cannot be read as "drained" once that writer lands: otherwise the
            // last row commits between the fetch and the check and the loop exits without it.
            const wasWriting = writing;
            const page = await reader.fetchRecent({ topic, since: cursor, limit: 500 });
            for (const m of page.messages) seen.push(String(m.backendMsgId));
            cursor = page.nextCursor;
            if (!wasWriting && page.messages.length === 0) return;
            if (cell.readerPollMs > 0) await sleep(cell.readerPollMs);
          }
        })();

        await Promise.all(
          writers.map(async (p, w) => {
            for (let i = 0; i < cell.perWriter; i++) {
              await p.post(topic, asHandle(`w${w}`), `w${w}-${i}`);
            }
          }),
        );
        writing = false;
        await readLoop;

        const full = await reader.fetchRecent({ topic, since: asCursor('0'), limit: expected * 2 });
        const stored = full.messages.map((m) => String(m.backendMsgId));
        expect(stored.length, 'writers did not all land').toBe(expected);

        const missed = stored.filter((id) => !seen.includes(id));
        expect(missed, 'reader advanced its cursor past a row it can never fetch again').toEqual([]);
        expect(seen, 'reader saw a message twice or out of order').toEqual(stored);
      } finally {
        await Promise.all([reader, ...writers].map((p) => p.disconnect()));
        await dropTable(table);
      }
    }, 120000);
  });
} else {
  describe.skip(`interleaved reader vs concurrent writers (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
