import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectFake, FakeSynapse } from './fake-synapse.js';

/**
 * CLASS: a request parameter the fake ignores is a parameter nothing grades. The `/messages` filter
 * is the one the catch-up paths depend on hardest: a server-side filter naming the wrong event type
 * makes every page return zero messages while the raw page still counts as full, so the cursor walks
 * past real history and the read comes back empty — silently, and permanently. The fake deliberately
 * serves `/messages` UNFILTERED (that is what keeps the client-side type/tag filtering under test),
 * so the filter can only be graded on the wire.
 *
 * Each call site is identified by (dir, limit, from) — never by the filter itself, which is what is
 * under test — and every recorded request must match exactly one, so a fifth call site added later
 * cannot slip in ungraded.
 */

const WRITER = asHandle('writer');
const LIMIT = 7;
const MESSAGES_ONLY = '{"types":["m.room.message"]}';
const q = (u: URL, k: string): string | null => u.searchParams.get(k);

const CALL_SITES: Record<string, { match: (u: URL) => boolean; filter: string | null }> = {
  'drainForward (catch-up from a cursor)': {
    match: (u) => q(u, 'dir') === 'f',
    filter: MESSAGES_ONLY,
  },
  'recentWindow (the since-less window)': {
    match: (u) => q(u, 'dir') === 'b' && q(u, 'limit') === String(LIMIT),
    filter: MESSAGES_ONLY,
  },
  // These two match a boundary `event_id` that may itself be a state event, which a filtered page
  // would hide — so for them the CORRECT wire is no filter at all.
  'backfill (a `limited` burst)': {
    match: (u) => q(u, 'dir') === 'b' && q(u, 'limit') === '100' && u.searchParams.has('from'),
    filter: null,
  },
  'timelineTip (the subscribe boundary)': {
    match: (u) => q(u, 'dir') === 'b' && q(u, 'limit') === '1' && !u.searchParams.has('from'),
    filter: null,
  },
};

let fake: FakeSynapse;
beforeEach(() => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('every /messages call site sends the filter its page semantics require', () => {
  it('all four fire, each with exactly the filter it needs', async () => {
    fake.syncCap = 2;
    const p = await connectFake({});
    const t = asTopic('wire');

    await p.post(t, WRITER, 'seed');
    const tail = (await p.fetchRecent({ topic: t, limit: LIMIT })).nextCursor; // recentWindow
    await p.post(t, WRITER, 'next');
    await p.fetchRecent({ topic: t, since: tail, limit: LIMIT }); // context + drainForward

    const got: string[] = [];
    await p.subscribe(t, (m) => got.push(m.content)); // timelineTip
    for (let i = 0; i < 5; i++) fake.addMessage(String(t), `burst${i}`); // 5 > syncCap → backfill
    await vi.waitFor(() => expect(got).toHaveLength(5), { timeout: 4000, interval: 10 });
    await p.disconnect();

    for (const [name, site] of Object.entries(CALL_SITES)) {
      const matched = fake.messagesRequests.filter(site.match);
      expect(matched.length, `${name} never fired`).toBeGreaterThan(0);
      for (const u of matched) expect(q(u, 'filter'), name).toBe(site.filter);
    }
    // No recorded request is unclassified, and none matches two call sites.
    for (const u of fake.messagesRequests) {
      const hits = Object.values(CALL_SITES).filter((s) => s.match(u));
      expect(hits, u.search).toHaveLength(1);
    }
    expect(fake.limitedEmitted).toBeGreaterThan(0);
  }, 20_000);
});
