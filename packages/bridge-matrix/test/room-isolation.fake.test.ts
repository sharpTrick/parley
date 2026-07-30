import { asHandle, asTopic, type FetchRecentResult, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixPlugin } from '../src/index.js';
import {
  aliasForTopic,
  connectFake,
  type Ev,
  fakeConfig,
  FakeSynapse,
  SERVER_NAME,
} from './fake-synapse.js';

/**
 * CLASS: a fake with ONE instance of the resource the plugin routes over certifies nothing about the
 * routing. Matrix's isolation boundary in the production configuration (`shared_room` UNSET) is the
 * ROOM: `belongs()` returns true unconditionally there, so the topic → alias → room_id chain is the
 * only thing keeping one topic's traffic out of another's catch-up, live path and allowlist bucket.
 * Every cell below therefore names the alias it expects resolved and the messages it expects back,
 * over two topics that must never see each other.
 */

const WRITER = asHandle('writer');
const A = asTopic('alpha');
const B = asTopic('beta');

let fake: FakeSynapse;
beforeEach(() => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const contents = (res: FetchRecentResult): string[] => res.messages.map((m) => m.content);
const bodiesIn = (alias: string): unknown[] =>
  fake
    .timelineOf(alias)
    .filter((e: Ev) => e.type === 'm.room.message')
    .map((e: Ev) => (e.content as { body?: unknown }).body);

/**
 * The room_ids a run actually READ from: every room-scoped catch-up path plus the room each `/sync`
 * scoped its filter to. Keep the `/sync` half — in per-topic mode that filter is the entire live-path
 * isolation boundary, and a subscribe that reads no `/messages` at all would otherwise be graded on
 * an empty list.
 */
const roomIdsRead = (u: URL): string[] => {
  const read = /\/rooms\/([^/]+)\/(messages|context)/.exec(u.pathname);
  if (read !== null) return [decodeURIComponent(read[1]!)];
  if (!u.pathname.endsWith('/v3/sync')) return [];
  const filter = JSON.parse(u.searchParams.get('filter') ?? '{}') as { room?: { rooms?: string[] } };
  return filter.room?.rooms ?? [];
};

const roomsRead = (): string[] => [...new Set(fake.requestUrls.flatMap(roomIdsRead))];

const MODES = [
  { name: 'per-topic', shared: false },
  { name: 'shared_room', shared: true },
] as const;

/**
 * How topic A is observed. Each row establishes its observation point, calls `land` (which posts one
 * more message to A and one to B), and returns what it saw.
 */
const OBSERVATIONS: Record<
  string,
  { expected: string[]; observe: (p: MatrixPlugin, land: () => Promise<void>) => Promise<string[]> }
> = {
  'fetchRecent (no since)': {
    expected: ['a0', 'a1'],
    observe: async (p, land) => {
      await land();
      return contents(await p.fetchRecent({ topic: A, limit: 10 }));
    },
  },
  'fetchRecent (since)': {
    expected: ['a1'],
    observe: async (p, land) => {
      const since = (await p.fetchRecent({ topic: A, limit: 10 })).nextCursor;
      await land();
      return contents(await p.fetchRecent({ topic: A, since, limit: 10 }));
    },
  },
  subscribe: {
    expected: ['a1'],
    observe: async (p, land) => {
      const got: string[] = [];
      await p.subscribe(A, (m) => got.push(m.content));
      await land();
      await vi.waitFor(() => expect(got.length).toBeGreaterThan(0), { timeout: 4000, interval: 5 });
      // Keep this settle, so that a MISROUTED sibling message has time to arrive and fail the row
      // rather than being read before the loop could deliver it.
      await settle(150);
      return got;
    },
  },
};

describe('a topic is read out of its own room only', () => {
  for (const mode of MODES) {
    const alias = (t: Topic): string => aliasForTopic(String(t), mode.shared);

    it(`${mode.name}: post resolves one alias per topic and keeps their timelines apart`, async () => {
      const p = await connectFake({ shared: mode.shared });
      await p.post(A, WRITER, 'a0');
      await p.post(B, WRITER, 'b0');

      expect(fake.directoryLookups).toEqual(
        mode.shared ? [alias(A)] : [alias(A), alias(B)],
      );
      expect(fake.rooms.map((r) => r.alias)).toEqual(
        mode.shared ? [alias(A)] : [alias(A), alias(B)],
      );
      if (mode.shared) {
        expect(bodiesIn(alias(A))).toEqual(['a0', 'b0']);
        // …and only the forgeable tag separates them, so both carry their own.
        expect(fake.sentBodies.map((b) => b['app.parley.topic'])).toEqual(['alpha', 'beta']);
      } else {
        expect(bodiesIn(alias(A))).toEqual(['a0']);
        expect(bodiesIn(alias(B))).toEqual(['b0']);
      }
      await p.disconnect();
    });

    for (const [name, row] of Object.entries(OBSERVATIONS)) {
      it(`${mode.name}: ${name} returns only topic A, out of topic A's room`, async () => {
        const p = await connectFake({ shared: mode.shared });
        await p.post(A, WRITER, 'a0');
        await p.post(B, WRITER, 'b0');
        fake.requestUrls.length = 0;

        const seen = await row.observe(p, async () => {
          await p.post(A, WRITER, 'a1');
          await p.post(B, WRITER, 'b1');
        });

        expect(seen).toEqual(row.expected);
        expect(roomsRead()).toEqual([fake.roomIdFor(alias(A))]);
        await p.disconnect();
      });
    }
  }
});

/**
 * CLASS: a per-backend name fold whose only test lives in another package as a hand-copied regex.
 * The fold is what keeps a topic name legal as an alias localpart AND — via core's `safeName` —
 * injective: two topics folding onto one localpart share a room, which in per-topic mode is the same
 * cross-delivery the table above exists to prevent. The expected localparts are LITERALS, so a fold
 * that stops folding (or a suffix that stops being appended) cannot be mirrored into a pass.
 */
const ALIAS_LEGAL = /^#[A-Za-z0-9._-]+:[^:]+$/;

const FOLDS: { topic: string; localpart: string }[] = [
  { topic: 'alpha', localpart: 'parley_alpha' },
  { topic: 'ops:prod', localpart: 'parley_ops_prod-1608f4e357' },
  { topic: 'team/frontend', localpart: 'parley_team_frontend-222ee3741b' },
  { topic: 'pay ments', localpart: 'parley_pay_ments-48bb595de9' },
  { topic: '#hash', localpart: 'parley__hash-c6e1f364ad' },
  { topic: '@at', localpart: 'parley__at-2c333a3a1e' },
  { topic: 'ünïcode', localpart: 'parley__n_code-979fe33b70' },
  { topic: 'tab\there', localpart: 'parley_tab_here-6db31cce25' },
  // The injectivity pair: one lossy fold and the legal name it would otherwise collide with.
  { topic: 'a/b', localpart: 'parley_a_b-3ec69c85a4' },
  { topic: 'a_b', localpart: 'parley_a_b' },
];

describe('an alias-hostile topic name folds to a legal, injective localpart', () => {
  for (const { topic, localpart } of FOLDS) {
    it(`${JSON.stringify(topic)} provisions ${localpart}`, async () => {
      fake.aliasExists = false;
      const p = await connectFake({});
      await p.post(asTopic(topic), WRITER, 'hello');

      expect(fake.createRoomBodies.map((b) => b.room_alias_name)).toEqual([localpart]);
      const alias = `#${localpart}:fake`;
      expect(fake.directoryLookups).toEqual([alias]);
      expect(alias).toMatch(ALIAS_LEGAL);
      expect(Buffer.byteLength(alias, 'utf8')).toBeLessThanOrEqual(255);
      await p.disconnect();
    });
  }

  it('the colliding pair lands in two different rooms', async () => {
    const p = await connectFake({});
    await p.post(asTopic('a/b'), WRITER, 'slash');
    await p.post(asTopic('a_b'), WRITER, 'underscore');

    expect(fake.rooms).toHaveLength(2);
    expect(contents(await p.fetchRecent({ topic: asTopic('a/b'), limit: 10 }))).toEqual(['slash']);
    expect(contents(await p.fetchRecent({ topic: asTopic('a_b'), limit: 10 }))).toEqual([
      'underscore',
    ]);
    await p.disconnect();
  });
});

/**
 * CLASS: a backend name rule with a LENGTH cap, which a charset fold cannot satisfy on its own. The
 * table above states the bound (`byteLength(alias) <= 255`) over rows too short to ever reach it, so
 * every row passed while a long topic produced an alias the homeserver refuses outright — and the
 * two halves of the seam then disagree about the same topic: `post` rejects with the homeserver's
 * own 400, while `fetchRecent` reports the empty page a never-written topic reports. Generated at
 * the boundary the fixture's `server_name` puts it, including a multi-byte row where the topic's
 * character count and its byte count diverge.
 */
const LOCALPART_BUDGET = 255 - `#:${SERVER_NAME}`.length;
/** Longest topic that still folds to an alias byte-for-byte, i.e. with no suffix and no truncation. */
const EXACT_FIT = LOCALPART_BUDGET - 'parley_'.length;

const LENGTHS: { name: string; topic: string }[] = [
  { name: 'well inside the limit', topic: 'x'.repeat(200) },
  { name: 'exactly at the limit', topic: 'x'.repeat(EXACT_FIT) },
  { name: 'one byte past it', topic: 'x'.repeat(EXACT_FIT + 1) },
  { name: 'past it by a page', topic: 'x'.repeat(EXACT_FIT + 256) },
  { name: 'far past it', topic: 'y'.repeat(1024) },
  { name: 'multi-byte, sanitized inside the limit', topic: 'é'.repeat(120) },
  { name: 'multi-byte, sanitized past it', topic: 'é'.repeat(LOCALPART_BUDGET) },
];

describe('a topic longer than the alias limit still folds to a legal, injective alias', () => {
  for (const { name, topic } of LENGTHS) {
    it(`${name} (${topic.length} chars): provisions one alias the homeserver would accept`, async () => {
      fake.aliasExists = false;
      const p = await connectFake({});
      await p.post(asTopic(topic), WRITER, 'hello');

      const localpart = String(fake.createRoomBodies[0]!.room_alias_name);
      const alias = `#${localpart}:${SERVER_NAME}`;
      expect(fake.directoryLookups).toEqual([alias]);
      expect(alias).toMatch(ALIAS_LEGAL);
      expect(Buffer.byteLength(alias, 'utf8')).toBeLessThanOrEqual(255);
      // …and the topic actually works: the same fold resolves it on the way back out.
      expect(contents(await p.fetchRecent({ topic: asTopic(topic), limit: 10 }))).toEqual(['hello']);
      await p.disconnect();
    });
  }

  it('two over-long topics sharing every truncated byte land in two different rooms', async () => {
    const p = await connectFake({});
    const base = 'z'.repeat(1024);

    await p.post(asTopic(`${base}-one`), WRITER, 'first');
    await p.post(asTopic(`${base}-two`), WRITER, 'second');

    expect(fake.rooms).toHaveLength(2);
    expect(contents(await p.fetchRecent({ topic: asTopic(`${base}-one`), limit: 10 }))).toEqual([
      'first',
    ]);
    expect(contents(await p.fetchRecent({ topic: asTopic(`${base}-two`), limit: 10 }))).toEqual([
      'second',
    ]);
    await p.disconnect();
  });

  it('a server_name leaving no room for a distinct localpart fails naming the plugin and the topic', async () => {
    const p = new MatrixPlugin();
    await p.connect({ ...fakeConfig(), server_name: 's'.repeat(250) });

    await expect(p.post(asTopic('ctx-payments'), WRITER, 'hello')).rejects.toThrow(
      /\[parley-matrix\][\s\S]*"ctx-payments"/,
    );
    await expect(p.fetchRecent({ topic: asTopic('ctx-payments'), limit: 10 })).rejects.toThrow(
      /\[parley-matrix\][\s\S]*"ctx-payments"/,
    );
    await p.disconnect();
  });
});
