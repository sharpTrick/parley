import { asCursor, asTopic, type Cursor } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';

// Class: per-page cursor arithmetic that no test can reach, because the page size is a constant
// larger than any limit the suite uses. `exclusiveMam`'s forward-paging loop is the only cursor
// arithmetic in this plugin, and with MAM_PAGE at 200 against archives of a handful of messages the
// server always answers `complete='true'` on the first page — so the loop breaks after one round
// trip and the line that advances the page cursor is never executed. Blanking that line (the
// classic non-advancing-paging defect: duplicate pages forever, or a catch-up that never moves)
// left the whole package suite green. The page size is now injectable, and the table crosses page
// size with limit and archive size so that `pageSize < limit < archive` — the only shape that runs
// the loop — is an ordinary row, and drains the archive one page at a time asserting the ids come
// back exactly once, in order, with a nextCursor that finally replays to empty.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv } from './fake-xmpp.js';

const TOPIC = asTopic('t-paging');

const rows = [1, 2, 200].flatMap((pageSize) =>
  [1, 5, 500].flatMap((limit) =>
    [0, 1, 7, 450].map((archive) => ({ pageSize, limit, archive })),
  ),
);

describe('XMPP MAM paging returns each archived message exactly once, in order', () => {
  it.each(rows)('page size $pageSize, limit $limit, archive of $archive', async (row) => {
    const fake = new FakeXmpp();
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'pager', mam_page: row.pageSize });
    const room = priv(plugin).roomJid(TOPIC);
    const archived = Array.from(
      { length: row.archive },
      (_, i) => fake.archiveOnly(room, `m${i}`).archId,
    );

    const drained: string[] = [];
    let cursor: Cursor = asCursor('');
    for (let page = 0; page <= row.archive + 1; page++) {
      const res = await plugin.fetchRecent({ topic: TOPIC, since: cursor, limit: row.limit });
      if (res.messages.length === 0) break;
      expect(res.messages.length).toBeLessThanOrEqual(row.limit);
      drained.push(...res.messages.map((m) => String(m.backendMsgId)));
      expect(String(res.nextCursor)).not.toBe(String(cursor)); // a page that arrived must advance
      cursor = res.nextCursor;
    }

    expect(drained).toEqual(archived);
    const replay = await plugin.fetchRecent({ topic: TOPIC, since: cursor, limit: row.limit });
    expect(replay.messages).toEqual([]);
    expect(String(replay.nextCursor)).toBe(String(cursor));
    await plugin.disconnect();
  });
});
