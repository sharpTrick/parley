import { asCursor, asHandle, asTopic, type Cursor } from '@sharptrick/parley-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BASE, canAuth, freshTopic } from './live-xmpp.js';

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
  // Keep the fall-through to the real client, so that the live cases at the bottom of this file
  // reach an actual server instead of whichever stand-in the previous test happened to leave here.
  return {
    ...actual,
    client: (opts: Parameters<typeof actual.client>[0]) => mockState.client ?? actual.client(opts),
  };
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
// from a paging loop here is the peer declaring one — `complete`, an empty page, or `limit` bodied
// items — so a peer that answers each query with the same page and never marks it complete re-issues
// the identical query forever, inside a call nothing above times out: core's fetchRecentBlocking
// bounds its own naps but awaits the plugin unbounded, so the MCP fetch_recent never answers and the
// agent hangs with no error anywhere. `since` picks WHICH loop runs — forward on `<after>`, backwards
// on `<before>` for the most-recent window — and each has to carry its own advance check, so the
// table crosses the shapes a page can take without advancing (bodied and body-less items, since the
// seam's own filter must not be what saves it; `complete='false'` and `complete` omitted entirely)
// with every `since` arm, and demands the call SETTLE in all of them.

const SETTLE_MS = 2_000;
const sinceArms = [
  { name: 'no cursor (the most-recent window)', since: undefined },
  { name: 'the zero cursor', since: asCursor('') },
  { name: 'a real archive id', since: asCursor('stuck-b') },
];
const nonAdvancing = sinceArms.flatMap((arm) =>
  ([true, false] as const).flatMap((bodies) =>
    (['false', 'omitted'] as const).map((complete) => ({ arm, bodies, complete })),
  ),
);

describe('XMPP MAM paging settles instead of spinning when the archive never advances', () => {
  it.each(nonAdvancing)(
    'from $arm.name, a page of $bodies-bodied items with complete $complete fails fast, naming the room',
    async ({ arm, ...fault }) => {
      const fake = new FakeXmpp();
      fake.nonAdvancingMam = fault;
      mockState.client = fake;
      const plugin = new XmppPlugin();
      await plugin.connect({ password: 'a-real-secret', nick: 'pager', mam_page: 2 });
      const room = priv(plugin).roomJid(TOPIC);

      const started = Date.now();
      const outcome = await plugin
        .fetchRecent({
          topic: TOPIC,
          ...(arm.since === undefined ? {} : { since: arm.since }),
          limit: 50,
        })
        .then(() => 'resolved', (e: Error) => e.message);

      expect(Date.now() - started).toBeLessThan(SETTLE_MS);
      expect(outcome).toContain(room);
      expect(outcome).toMatch(/did not advance/);
      await plugin.disconnect();
    },
    SETTLE_MS * 2,
  );
});

// The since-less window is the one arm whose paging is defined by RSM `<before>` (XEP-0059 §2.5),
// and the fixture above is this suite's own model of how a server answers one: which page an id
// bounds, and when `<fin complete='true'>` appears. A model is not evidence, so the same class —
// "the most-recent window is `limit` MESSAGES, however many pages the server needs to produce them"
// — is graded once against a real MAM implementation, at page sizes below the limit so the walk
// genuinely runs. A server that read `<before>id</before>` differently would show up here as a
// duplicated, missing or reordered message rather than as a fixture that agrees with itself.

const serverUp = await canAuth(BASE);
const liveWindows = [1, 2, 5].flatMap((pageSize) => [1, 3, 6].map((limit) => ({ pageSize, limit })));

describe.skipIf(!serverUp)('XMPP reads the most-recent window off a real MAM archive', () => {
  beforeEach(() => {
    mockState.client = undefined;
  });

  it.each(liveWindows)('page size $pageSize, limit $limit', async ({ pageSize, limit }) => {
    const plugin = new XmppPlugin();
    await plugin.connect({ ...BASE, mam_page: pageSize });
    const topic = freshTopic('recent-window');
    const sent: string[] = [];
    for (let i = 0; i < 6; i++) {
      sent.push(`m${String(i)}`);
      await plugin.post(topic, asHandle('writer'), `m${String(i)}`);
    }

    const window = await plugin.fetchRecent({ topic, limit });
    expect(window.messages.map((m) => m.content)).toEqual(sent.slice(-limit));
    // The window tail is the newest row the read saw, so feeding it back yields nothing and the
    // walk backwards cannot have rewound the caller past what it was just handed.
    expect(String(window.nextCursor)).toBe(String(window.messages.at(-1)?.cursor));
    const replay = await plugin.fetchRecent({ topic, since: window.nextCursor, limit: 100 });
    expect(replay.messages).toEqual([]);
    await plugin.disconnect();
  }, 60_000);
});
