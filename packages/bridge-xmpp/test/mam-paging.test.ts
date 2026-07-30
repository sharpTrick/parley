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

// Class: a seam call whose loop termination depends ENTIRELY on server-supplied progress. Every exit
// from the paging loop above is the peer declaring one — `complete`, an empty page, or `limit`
// bodied items — so a peer that answers each `<after>X</after>` with a page tailed by X again and
// never marks it complete re-issues the identical query forever, inside a call nothing above times
// out: core's fetchRecentBlocking bounds its own naps but awaits the plugin unbounded, so the MCP
// fetch_recent never answers and the agent hangs with no error anywhere. The table walks the shapes
// a page can take without advancing — bodied and body-less items (the seam's own filter must not be
// what saves it), `complete='false'` and `complete` omitted entirely — and demands the call SETTLE.

const SETTLE_MS = 2_000;
const nonAdvancing = ([true, false] as const).flatMap((bodies) =>
  (['false', 'omitted'] as const).map((complete) => ({ bodies, complete })),
);

describe('XMPP MAM paging settles instead of spinning when the archive never advances', () => {
  it.each(nonAdvancing)(
    'a page of $bodies-bodied items with complete $complete fails fast, naming the room',
    async (fault) => {
      const fake = new FakeXmpp();
      fake.nonAdvancingMam = fault;
      mockState.client = fake;
      const plugin = new XmppPlugin();
      await plugin.connect({ password: 'a-real-secret', nick: 'pager', mam_page: 2 });
      const room = priv(plugin).roomJid(TOPIC);

      const started = Date.now();
      const outcome = await plugin
        .fetchRecent({ topic: TOPIC, since: asCursor(''), limit: 50 })
        .then(() => 'resolved', (e: Error) => e.message);

      expect(Date.now() - started).toBeLessThan(SETTLE_MS);
      expect(outcome).toContain(room);
      expect(outcome).toMatch(/did not advance/);
      await plugin.disconnect();
    },
    SETTLE_MS * 2,
  );
});
