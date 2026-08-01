import {
  asHandle, asTopic, type FetchRecentResult, safeName, type Topic,
} from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boundedLocalpart } from '../src/alias.js';
import { MatrixPlugin, sanitizeAlias } from '../src/index.js';
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
 * How topic A is observed. Each row establishes its observation point, calls `land` (which puts one
 * more message in A's room and one in B's), and returns what it saw. `expected` is a function of
 * whether the landed message is one this mode delivers, so the same row grades both outcomes.
 */
const OBSERVATIONS: Record<
  string,
  {
    expected: (delivered: boolean) => string[];
    observe: (
      p: MatrixPlugin,
      land: () => Promise<void>,
      expected: string[],
    ) => Promise<string[]>;
  }
> = {
  'fetchRecent (no since)': {
    expected: (delivered) => (delivered ? ['a0', 'a1'] : ['a0']),
    observe: async (p, land) => {
      await land();
      return contents(await p.fetchRecent({ topic: A, limit: 10 }));
    },
  },
  'fetchRecent (since)': {
    expected: (delivered) => (delivered ? ['a1'] : []),
    observe: async (p, land) => {
      const since = (await p.fetchRecent({ topic: A, limit: 10 })).nextCursor;
      await land();
      return contents(await p.fetchRecent({ topic: A, since, limit: 10 }));
    },
  },
  subscribe: {
    expected: (delivered) => (delivered ? ['a1'] : []),
    observe: async (p, land, expected) => {
      const got: string[] = [];
      await p.subscribe(A, (m) => got.push(m.content));
      await land();
      await vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(expected.length), {
        timeout: 4000,
        interval: 5,
      });
      // Keep this settle, so that a MISROUTED sibling message — or one this mode must drop — has
      // time to arrive and fail the row rather than being read before the loop could deliver it.
      await settle(150);
      return got;
    },
  },
};

/**
 * WHO wrote the message that lands during the observation. `delivered` states the mode in which it
 * reaches topic A, and that is the whole per-topic/`shared_room` contract: the room is the boundary
 * in per-topic mode (the tag is ignored, so a native client's untagged message IS topic A's), while
 * in `shared_room` mode the tag is the boundary and an untagged message belongs to no topic.
 */
const WRITERS: Record<
  string,
  { land: (p: MatrixPlugin, alias: (t: Topic) => string) => Promise<void>; delivered: (shared: boolean) => boolean }
> = {
  'through Parley (tagged)': {
    land: async (p) => {
      await p.post(A, WRITER, 'a1');
      await p.post(B, WRITER, 'b1');
    },
    delivered: () => true,
  },
  'from a native Matrix client (untagged)': {
    land: async (_p, alias) => {
      fake.addUntagged('a1', alias(A));
      fake.addUntagged('b1', alias(B));
    },
    delivered: (shared) => !shared,
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
      for (const [writerName, writer] of Object.entries(WRITERS)) {
        const delivered = writer.delivered(mode.shared);
        it(`${mode.name}: ${name} ${delivered ? 'returns' : 'drops'} a message written ${writerName}, out of topic A's room`, async () => {
          const p = await connectFake({ shared: mode.shared });
          await p.post(A, WRITER, 'a0');
          await p.post(B, WRITER, 'b0');
          fake.requestUrls.length = 0;

          const expected = row.expected(delivered);
          const seen = await row.observe(p, () => writer.land(p, alias), expected);

          expect(seen).toEqual(expected);
          expect(roomsRead()).toEqual([fake.roomIdFor(alias(A))]);
          await p.disconnect();
        });
      }
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
  { topic: 'ops:prod', localpart: 'parley_ops_prod-1608f4e357676264' },
  { topic: 'team/frontend', localpart: 'parley_team_frontend-222ee3741b0781e7' },
  { topic: 'pay ments', localpart: 'parley_pay_ments-48bb595de96958ca' },
  { topic: '#hash', localpart: 'parley__hash-c6e1f364ad5ec08b' },
  { topic: '@at', localpart: 'parley__at-2c333a3a1e0609ca' },
  { topic: 'ünïcode', localpart: 'parley__n_code-979fe33b70c7bba4' },
  { topic: 'tab\there', localpart: 'parley_tab_here-6db31cce25cd1c3f' },
  // The injectivity pair: one lossy fold and the legal name it would otherwise collide with.
  { topic: 'a/b', localpart: 'parley_a_b-3ec69c85a4ff9683' },
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

/**
 * CLASS: the fold is injective across EVERY branch, including the one it grew for itself. Two
 * hand-picked pairs grade the two branches `safeName` owns; the length cap adds a third that mints a
 * name of its own — and any name this fold publishes is a topic somebody can ask for, because a room
 * alias is public. So each seed contributes the names the fold produced FOR it, re-fed as topics and
 * folded again, closed over two rounds: a branch reachable from another branch's output collides
 * here rather than in a shared room. Swept over an alphabet the fold leaves alone and two it
 * rewrites, over lengths straddling the truncation boundary, and over `server_name` lengths — the
 * budget, and with it the truncation point, moves with the server name.
 */
const FOLD_ALPHABETS: Record<string, string> = {
  'legal ascii': 'x',
  'lossy ascii': '/',
  'multi-byte': 'é',
};

const FOLD_SERVER_NAMES = [
  SERVER_NAME,
  'parley.local',
  `${'a.'.repeat(60)}example.com`,
  // Long enough that the truncation branch keeps barely more of the topic than the digest costs.
  's'.repeat(200),
];

/** Every topic reachable from `seeds` by re-feeding the fold its own output, `rounds` deep. */
function foldClosure(seeds: string[], serverName: string, rounds: number): string[] {
  const topics = new Set(seeds);
  for (let round = 0; round < rounds; round++) {
    for (const topic of [...topics]) {
      topics.add(boundedLocalpart(asTopic(topic), serverName).slice('parley_'.length));
      topics.add(safeName(asTopic(topic), sanitizeAlias));
    }
  }
  return [...topics];
}

/** Names more than one topic folds onto, with the topics that share each — `[]` when injective. */
function collisions(topics: string[], fold: (topic: string) => string): string[][] {
  const byName = new Map<string, string[]>();
  for (const topic of new Set(topics)) {
    const name = fold(topic);
    byName.set(name, [...(byName.get(name) ?? []), topic]);
  }
  return [...byName.values()].filter((sharing) => sharing.length > 1);
}

const foldFor =
  (serverName: string) =>
  (topic: string): string =>
    boundedLocalpart(asTopic(topic), serverName);

describe('no two topics fold onto one alias localpart', () => {
  it('recognizes a collision when it sees one', () => {
    const truncating = (t: string): string => t.slice(0, 3);
    expect(collisions(['abcd', 'abce'], truncating)).toEqual([['abcd', 'abce']]);
    expect(collisions(['abcd', 'abcd'], truncating)).toEqual([]); // one topic, listed twice
    expect(collisions(['abcd', 'zbcd'], truncating)).toEqual([]);
  });

  for (const serverName of FOLD_SERVER_NAMES) {
    const budget = 255 - Buffer.byteLength(`#:${serverName}`, 'utf8');
    const exactFit = budget - 'parley_'.length;
    const lengths = [1, 8, exactFit - 1, exactFit, exactFit + 1, 4 * exactFit];

    for (const [alphabet, ch] of Object.entries(FOLD_ALPHABETS)) {
      it(`server_name of ${serverName.length} chars / ${alphabet}: injective over its own output`, () => {
        const seeds = lengths.map((n) => ch.repeat(n));
        const topics = foldClosure(seeds, serverName, 2);

        expect(topics.length).toBeGreaterThan(seeds.length); // the closure actually grew
        expect(collisions(topics, foldFor(serverName))).toEqual([]);
      });
    }
  }
});

/**
 * The same class through the seam: a topic spelled like a name this fold PUBLISHED must not read or
 * write the room that name addresses. Parameterized over each name a topic's alias exposes, so a
 * branch that starts publishing a constructible name is graded end to end rather than in arithmetic.
 */
const CONSTRUCTED_FROM: Record<string, { victim: string; construct: (topic: string) => string }> = {
  'a truncated localpart': {
    victim: 'x'.repeat(4 * (255 - `#:${SERVER_NAME}`.length)),
    construct: (t) => boundedLocalpart(asTopic(t), SERVER_NAME).slice('parley_'.length),
  },
  'a disambiguated safeName': {
    victim: 'ops:prod',
    construct: (t) => safeName(asTopic(t), sanitizeAlias),
  },
};

describe('a topic spelled like another topic’s published alias gets its own room', () => {
  for (const [name, { victim, construct }] of Object.entries(CONSTRUCTED_FROM)) {
    it(`a topic built from ${name} cross-delivers neither way`, async () => {
      const attacker = construct(victim);
      expect(attacker).not.toBe(victim);
      const p = await connectFake({});

      await p.post(asTopic(victim), WRITER, 'victim');
      await p.post(asTopic(attacker), WRITER, 'attacker');

      expect(fake.rooms).toHaveLength(2);
      expect(contents(await p.fetchRecent({ topic: asTopic(victim), limit: 10 }))).toEqual([
        'victim',
      ]);
      expect(contents(await p.fetchRecent({ topic: asTopic(attacker), limit: 10 }))).toEqual([
        'attacker',
      ]);
      await p.disconnect();
    });
  }
});
