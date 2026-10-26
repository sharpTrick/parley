import { asHandle, asTopic, type Cursor, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { dropTable, isUp, PG_URL, rand } from './pg-harness.js';

// A cursor is only worth anything if it is REPLAYABLE: whatever `fetchRecent` hands back must, when
// fed straight back in, deliver every message posted after it and nothing that came before. The
// dangerous page is the EMPTY one — there is no row to take a cursor from, so the plugin has to
// invent one, and a cursor invented above the live sequence silently loses every message below it
// with no error anywhere. `catch-up on start` against a topic with no rows yet is exactly that page,
// and it is the one shape conformance cannot see: its never-posted-topic case replays the cursor
// against the still-empty topic, so a cursor that is replayable AND ahead of everything passes.
//
// So the assertion is the round trip, over both ways a page comes back empty (no `since` on an
// untouched topic, and a `since` already at the tail) and over batch sizes either side of the
// default page limit.

interface Cell {
  /** How the empty page is obtained: with no `since` at all, or with a `since` at the tail. */
  emptiedBy: 'no-since' | 'drained-tail';
  /** How many messages are posted AFTER the empty page's cursor is taken. */
  posted: number;
}

/** fetchRecent's own default `limit`; a page of more than this must not silently truncate. */
const DEFAULT_LIMIT = 100;

const CELLS: Cell[] = (['no-since', 'drained-tail'] as const).flatMap((emptiedBy) =>
  [0, 1, 5, DEFAULT_LIMIT + 1].map((posted) => ({ emptiedBy, posted })),
);

if (await isUp(PG_URL)) {
  describe('a cursor taken from an EMPTY page still delivers everything posted after it', () => {
    it.each(
      CELLS.map((c) => [`${c.emptiedBy}, ${c.posted} message(s) posted afterwards`, c] as const),
    )('%s', async (_label, cell) => {
      const table = `parley_cur_${rand()}`;
      const topic: Topic = asTopic(`cur-${rand()}`);
      const plugin = new PostgresPlugin();
      await plugin.connect({ url: PG_URL, table_name: table });

      try {
        // Another topic in the same table carries rows the whole time, so a cursor minted from a
        // GLOBAL max seq (rather than this topic's page) is just as visible as an invented constant.
        const busy = asTopic(`busy-${rand()}`);
        for (let i = 0; i < 3; i++) await plugin.post(busy, asHandle('other'), `noise${i}`);

        let empty: Cursor;
        if (cell.emptiedBy === 'no-since') {
          const page = await plugin.fetchRecent({ topic });
          expect(page.messages, 'an untouched topic returned rows').toEqual([]);
          empty = page.nextCursor;
        } else {
          await plugin.post(topic, asHandle('u'), 'seed');
          const seeded = await plugin.fetchRecent({ topic });
          const tail = seeded.nextCursor;
          const page = await plugin.fetchRecent({ topic, since: tail });
          expect(page.messages, 'a drained topic returned rows').toEqual([]);
          empty = page.nextCursor;
        }

        const expected = Array.from({ length: cell.posted }, (_, i) => `after${i}`);
        for (const content of expected) await plugin.post(topic, asHandle('u'), content);

        const caught = await plugin.fetchRecent({ topic, since: empty, limit: DEFAULT_LIMIT * 10 });
        expect(caught.messages.map((m) => m.content), 'messages lost below an empty page').toEqual(
          expected,
        );

        const last = caught.messages.at(-1);
        expect(String(caught.nextCursor)).toBe(
          last === undefined ? String(empty) : String(last.cursor),
        );
        // Replaying the page's own cursor must now be a no-op, not a rewind.
        expect((await plugin.fetchRecent({ topic, since: caught.nextCursor })).messages).toEqual([]);
      } finally {
        await plugin.disconnect();
        await dropTable(table);
      }
    }, 120000);
  });
} else {
  describe.skip(`empty-page cursor contract (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
