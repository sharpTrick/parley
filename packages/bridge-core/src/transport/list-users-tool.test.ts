import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it, vi } from 'vitest';
import { MAX_POST_TOPICS } from '../config.js';
import {
  DEFAULT_PRESENCE_TOPIC,
  encodePresence,
  MAX_RECORD_TOPICS,
  MAX_ROSTER_ENTRIES,
  MAX_TOPIC_LEN,
  type PresenceKind,
} from '../engine/presence.js';
import { MAX_AMBIGUITY } from '../regex-safety.js';
import { asBackendMsgId, asCursor, asHandle, asTopic, type Message } from '../message.js';
import { NoSuchTopicError, type FetchRecentResult } from '../seam.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import {
  harness,
  parse,
  postBeat,
  PRESENCE_TOPIC,
  type RosterResult,
  type ToolText,
} from '../testing/tool-cases.js';
import { DEFAULT_ROSTER_LIMIT, PRESENCE_FETCH_LIMIT } from './tools.js';

/** Each `[a-z]?` doubles the paths a screened source may explore, so this sits AT the screen's cap. */
const OPTIONAL_ATOMS = Math.log2(MAX_AMBIGUITY);
const costlySource = (n: number): string => `${'[a-z]?'.repeat(OPTIONAL_ATOMS)}Z${n}`;
/** A full record's worth of distinct screened-but-costly sources — legal on any beat. */
const costlyBank = (seed: number): string[] =>
  Array.from({ length: MAX_RECORD_TOPICS }, (_, i) => costlySource(seed * MAX_RECORD_TOPICS + i));

/**
 * One subject: `parley_list_users` — the reachability roster core derives from the presence topic.
 * What it contains, in what order, how far it reaches, and how much of the agent's context and
 * decode budget an untrusted emitter can spend through it.
 */

describe('parley_list_users (presence-derived reachability roster)', () => {
  const NOW = 1_000_000;
  const TTL = 90_000;

  type Beat = [handle: string, topics: string[], kind: PresenceKind, ago: number, postTopics?: string[]];
  interface Scope {
    topics?: string[];
    postPatterns?: string[];
  }

  /** A harness at a fixed clock, seeded with presence beats `ago` ms before NOW. */
  async function roster(beats: Beat[], scope: Scope = {}) {
    const h = await harness({
      now: () => NOW,
      presenceTtlMs: TTL,
      topics: scope.topics,
      postPatterns: scope.postPatterns,
    });
    for (const [handle, topics, kind, ago, postTopics] of beats) {
      await postBeat(h.plugin, handle, topics, kind, NOW - ago, postTopics ?? []);
    }
    return h;
  }

  async function listed(
    client: Client,
    args: Record<string, unknown>,
  ): Promise<Array<[handle: string, online: boolean]>> {
    const out = parse(await client.callTool({ name: 'parley_list_users', arguments: args })) as RosterResult;
    return out.users.map((u) => [u.handle, u.online]);
  }

  /**
   * The roster is a function of (beats x options), and every option interacts with the sort: each row
   * therefore pins ORDER as well as membership, so the most-recently-seen-first sort is falsifiable
   * rather than riding along. The final three rows are option PAIRS that no case covered — where a
   * regression would land in the gap between two green single-option tests.
   */
  const ROWS: Array<
    [name: string, beats: Beat[], args: Record<string, unknown>, expected: Array<[string, boolean]>, scope?: Scope]
  > = [
    ['an online peer needs no real post', [['claude-a', ['ctx'], 'hello', 1_000]], {}, [['claude-a', true]]],
    [
      'the glob filter selects by handle',
      [['claude-a', ['ctx'], 'heartbeat', 1_000], ['human-x', ['ctx'], 'heartbeat', 1_000]],
      { filter: 'claude-*' },
      [['claude-a', true]],
    ],
    [
      'a beat past the TTL is listed as offline, after the online peers',
      [['stale', ['ctx'], 'heartbeat', TTL + 1], ['fresh', ['ctx'], 'heartbeat', 1_000]],
      {},
      [['fresh', true], ['stale', false]],
    ],
    [
      'online_only drops the offline peer',
      [['stale', ['ctx'], 'heartbeat', TTL + 1], ['fresh', ['ctx'], 'heartbeat', 1_000]],
      { online_only: true },
      [['fresh', true]],
    ],
    [
      'a peer that said goodbye is offline but still reachable',
      [['awake', ['ctx'], 'heartbeat', 1_000], ['napping', ['ctx'], 'goodbye', 5_000]],
      {},
      [['awake', true], ['napping', false]],
    ],
    [
      'since_ms bounds how far back offline peers are included',
      [['recent', ['ctx'], 'goodbye', 10_000], ['ancient', ['ctx'], 'goodbye', 5_000_000]],
      { since_ms: 60_000 },
      [['recent', false]],
    ],
    [
      'limit caps the roster AFTER the most-recently-seen-first sort',
      [
        ['a', ['ctx'], 'heartbeat', 3_000],
        ['b', ['ctx'], 'heartbeat', 1_000],
        ['c', ['ctx'], 'heartbeat', 2_000],
      ],
      { limit: 2 },
      [['b', true], ['c', true]],
    ],
    [
      'a peer advertising only topics I do not subscribe to is excluded',
      [['stranger', ['some-other-ctx'], 'hello', 1_000]],
      {},
      [],
    ],
    [
      'a peer I can reach only through my own post pattern is included',
      [['peer', ['ctx-theirs'], 'hello', 1_000]],
      {},
      [['peer', true]],
      { topics: ['ctx-mine'], postPatterns: ['ctx-.*'] },
    ],
    [
      'a peer whose advertised pattern reaches a topic I subscribe to is included',
      [['peer', ['ctx-theirs'], 'hello', 1_000, ['ctx-.*']]],
      {},
      [['peer', true]],
      { topics: ['ctx-mine'] },
    ],
    [
      'a peer with no shared channel in either direction is excluded',
      [['stranger', ['other'], 'hello', 1_000, ['unrelated-.*']]],
      {},
      [],
      { topics: ['ctx'] },
    ],
    [
      'topic scopes the roster to that topic',
      [['claude-a', ['ctx'], 'hello', 1_000], ['claude-b', ['ctx-reviews'], 'hello', 1_000]],
      { topic: 'ctx' },
      [['claude-a', true]],
    ],
    [
      'a pattern-allowed topic is a valid scope',
      [['claude-a', ['ctx-adhoc'], 'hello', 1_000]],
      { topic: 'ctx-adhoc' },
      [['claude-a', true]],
      { postPatterns: ['ctx-.*'] },
    ],
    [
      'a scope includes peers who can POST there, not only its subscribers',
      [['poster', ['elsewhere'], 'hello', 1_000, ['ctx-.*']], ['subber', ['ctx-adhoc'], 'hello', 1_000]],
      { topic: 'ctx-adhoc' },
      [['poster', true], ['subber', true]], // equal lastSeenMs ⇒ handle-ascending tiebreak
      { postPatterns: ['ctx-.*'] },
    ],
    [
      'online_only x since_ms: the window cannot resurrect an offline peer',
      [
        ['fresh', ['ctx'], 'heartbeat', 1_000],
        ['recently-gone', ['ctx'], 'heartbeat', TTL + 1],
        ['ancient', ['ctx'], 'goodbye', 5_000_000],
      ],
      { online_only: true, since_ms: 5_000_000 },
      [['fresh', true]],
    ],
    [
      'filter x limit: the cap applies to the FILTERED roster',
      [
        ['claude-a', ['ctx'], 'heartbeat', 3_000],
        ['claude-b', ['ctx'], 'heartbeat', 1_000],
        ['human-x', ['ctx'], 'heartbeat', 2_000],
      ],
      { filter: 'claude-*', limit: 1 },
      [['claude-b', true]],
    ],
    [
      'scope x online_only: both narrow, neither overrides the other',
      [
        ['on-scope-live', ['ctx'], 'heartbeat', 1_000],
        ['on-scope-stale', ['ctx'], 'heartbeat', TTL + 1],
        ['off-scope-live', ['ctx-reviews'], 'heartbeat', 500],
      ],
      { topic: 'ctx', online_only: true },
      [['on-scope-live', true]],
    ],
  ];

  it.each(ROWS)('%s', async (_name, beats, args, expected, scope) => {
    const { client } = await roster(beats, scope);
    expect(await listed(client, args)).toEqual(expected);
  });

  it("surfaces a peer's full entry: handle, online, topics, postTopics, lastSeenMs", async () => {
    const { client } = await roster([['claude-a', ['ctx'], 'hello', 1_000, ['ctx-.*']]], { topics: ['ctx'] });
    const out = parse(await client.callTool({ name: 'parley_list_users', arguments: {} })) as RosterResult;
    expect(out).toEqual({
      users: [
        { handle: 'claude-a', online: true, topics: ['ctx'], postTopics: ['ctx-.*'], lastSeenMs: NOW - 1_000 },
      ],
      truncated: false,
    });
  });

  it('flags truncated when the scanned presence history fills the page', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: ['ctx'] });
    // Fill the fetch page so older offline peers could be clipped.
    for (let i = 0; i < PRESENCE_FETCH_LIMIT; i++) {
      await postBeat(plugin, 'flood', ['ctx'], 'heartbeat', NOW - 1_000 - i);
    }
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    expect(out.truncated).toBe(true);
  });

  /**
   * The roster reads the presence topic with NO cursor, so on a bus carrying more beats than one
   * page it is built from whichever END of history the backend's default window returns. Newest is
   * the only answer that serves the roster's purpose and the one every shipped backend gives — and
   * a fake returning the oldest instead makes this whole tool grade backwards while staying green.
   * So pin the direction where the TOOL is, not only at the seam.
   */
  it('builds the roster from the NEWEST presence page when history overflows it', async () => {
    const total = PRESENCE_FETCH_LIMIT + 5;
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: ['ctx'] });
    for (let i = 0; i < total; i++) {
      await postBeat(plugin, `peer-${i}`, ['ctx'], 'heartbeat', NOW - (total - i) * 10);
    }
    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as RosterResult;
    const handles = out.users.map((u) => u.handle);
    expect(handles[0]).toBe(`peer-${total - 1}`); // the freshest beat leads
    expect(handles).not.toContain('peer-0'); // the stalest never reached the page
    expect(out.truncated).toBe(true);
  });

  it('ignores real-topic senders (the presence stream is isolated)', async () => {
    const { client, plugin } = await roster([]);
    await plugin.post(asTopic('ctx'), asHandle('chatty'), 'a real message'); // NOT a presence beat
    expect(await listed(client, {})).toEqual([]);
  });

  it('ignores an un-compilable / over-long peer post-pattern without crashing (untrusted input)', async () => {
    // A hostile beat: a broken regex source plus a huge one. Neither should reach me, and the call
    // must not throw — the peer has no subscribed overlap and no valid pattern that covers 'ctx'.
    const { client } = await roster([['hostile', ['other'], 'hello', 1_000, ['(', 'x'.repeat(10_000)]]], {
      topics: ['ctx'],
    });
    expect(await listed(client, {})).toEqual([]);
  });

  /**
   * A hostile peer plants the maximum 64 catastrophic-backtracking regex sources on the presence
   * topic (a raw backend write, outside the tool allowlist), then the reader calls list_users. On
   * unscreened code the `.test` loop never returns; the WALL-CLOCK bound, not a green suite, is the
   * proof. Both shapes are here because the second slipped the screen the first one motivated:
   * `{40}` has no unbounded outer quantifier, yet V8 unrolls it into 40 sequential `*`-bodies.
   */
  it.each([
    ['an unbounded nested quantifier', '((([a-z-]+)+)+)+[0-9]'],
    ['a BOUNDED exact-count nested quantifier', '([a-z-]*){40}[0-9]'],
  ])('a beat of 64 postTopics carrying %s does not hang list_users', async (_label, evil) => {
    const { client } = await roster(
      [['attacker', ['some-other-ctx'], 'hello', 1_000, Array<string>(64).fill(evil)]],
      { topics: ['ctx'] },
    );
    const t0 = performance.now();
    expect(await listed(client, {})).toEqual([]); // no shared channel ⇒ the pathological peer is excluded
    expect(performance.now() - t0).toBeLessThan(1_000); // unfixed: never returns
  });

  it('rejects a topic outside the allowlist', async () => {
    const { client } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    const res = (await client.callTool({
      name: 'parley_list_users',
      arguments: { topic: 'secret' },
    })) as ToolText;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('topic not allowed');
  });

  it('surfaces an arbitrary backend failure as an isError result, not a fake-empty roster', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    // A real outage (connection loss, auth expiry, DB error) rejects fetchRecent — it must NOT
    // collapse into a healthy `{ users: [], truncated: false }` the agent would trust.
    plugin.fetchRecent = async () => {
      throw new Error('backend down');
    };
    const res = (await client.callTool({
      name: 'parley_list_users',
      arguments: {},
    })) as ToolText;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('backend down');
  });

  it('maps an explicit NoSuchTopicError to an empty roster (presence topic genuinely absent)', async () => {
    const { client, plugin } = await harness({ now: () => NOW, presenceTtlMs: TTL });
    // Only NoSuchTopicError means "topic not present yet" ⇒ nobody seen; this is a normal result.
    plugin.fetchRecent = async () => {
      throw new NoSuchTopicError(DEFAULT_PRESENCE_TOPIC);
    };
    const res = (await client.callTool({
      name: 'parley_list_users',
      arguments: {},
    })) as ToolText;
    expect(res.isError).toBeFalsy();
    expect(parse(res)).toEqual({ users: [], truncated: false });
  });
});

/**
 * The roster is rebuilt from ONE fixed page of the presence topic, so occupancy of that page is a
 * shared resource: a peer beating far more often than the rest fills it on its own and every quieter
 * peer disappears from hand-off discovery. The seam cannot page BACKWARD (`fetchRecent` takes a
 * `since`, not a `before`), so core cannot recover them — which makes the tool description the control,
 * and an undisclosed silent gap the actual defect. Pin both halves: the flag the handler raises, and
 * the sentence that tells the agent what a raised flag means.
 */
describe('a noisy presence emitter is disclosed, not silently hidden', () => {
  const PRESENCE_PAGE = 500; // the handler's PRESENCE_FETCH_LIMIT

  it('a flooder that fills the presence page marks the roster truncated', async () => {
    const { client, plugin } = await harness();
    const now = Date.now();
    // A real backend answers with the MOST RECENT window, so model that rather than FakePlugin's
    // oldest-first slice: the quiet peer's single beat is the one that falls off the page.
    await postBeat(plugin, 'quiet-peer', ['ctx'], 'hello', now - 1_000, [], 'quiet-1');
    for (let i = 0; i < PRESENCE_PAGE; i++) {
      await postBeat(plugin, 'flooder', ['ctx'], 'heartbeat', now - 500, [], `flood-${i}`);
    }
    const all = plugin.fetchRecent.bind(plugin);
    plugin.fetchRecent = async (args) => {
      const page = await all({ ...args, limit: 10_000 });
      const limit = args.limit ?? page.messages.length;
      const messages = page.messages.slice(-limit);
      return { messages, nextCursor: messages.at(-1)?.cursor ?? page.nextCursor };
    };

    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as { users: Array<{ handle: string }>; truncated: boolean };

    expect(out.truncated).toBe(true); // the only signal the caller gets
    expect(out.users.map((u) => u.handle)).toEqual(['flooder']);
    expect(out.users.map((u) => u.handle)).not.toContain('quiet-peer');

    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'parley_list_users')!.description!;
    expect(description).toContain('truncated=true');
    // Saying "older offline peers may be missing" would understate it: a LIVE peer can be missing too.
    expect(description).toMatch(/beats far more often|hide quieter/);
  });

  /**
   * `limit` is what the handler ASKS for, not what it gets — nonconformant.ts models a longer page as
   * a shape core must survive — and every extra beat is another roster entry going verbatim into the
   * agent's context. Fold at most one page's worth however many the plugin hands back.
   */
  it('an over-delivering presence page still yields a bounded roster', async () => {
    const { client, plugin } = await harness();
    const now = Date.now();
    const OVER = PRESENCE_PAGE * 4;
    plugin.fetchRecent = async () => {
      const messages = Array.from({ length: OVER }, (_unused, i) => ({
        topic: PRESENCE_TOPIC,
        senderHandle: asHandle(`peer-${i}`),
        content: encodePresence({
          v: 2 as const,
          kind: 'heartbeat' as const,
          at: now - 1_000,
          topics: ['ctx'],
          postTopics: [],
          instanceId: `inst-${i}`,
        }),
        timestamp: new Date(i * 1000).toISOString(),
        backendMsgId: asBackendMsgId(String(i)),
        cursor: asCursor(String(i)),
        mentions: [],
      }));
      return { messages, nextCursor: asCursor(String(OVER)) };
    };

    const out = parse(
      await client.callTool({ name: 'parley_list_users', arguments: {} }),
    ) as { users: unknown[]; truncated: boolean };

    expect(out.users.length).toBeLessThanOrEqual(PRESENCE_PAGE);
    expect(out.users.length).toBeGreaterThan(0); // bounded, not emptied
    expect(out.truncated).toBe(true);
  });
});

/**
 * Every byte of a roster entry is untrusted self-reported text going verbatim into the agent's
 * context, and an entry is bounded but not small — MAX_RECORD_TOPICS topics AND post-patterns, each
 * up to MAX_TOPIC_LEN. So the entry COUNT decides the size of that context, and the handle a beat
 * declares is as cheap to mint as a message: one writer fills the page with distinct peers. An
 * omitted `limit` therefore has to mean a bounded page rather than "however many a stranger
 * advertised". Grade the answer the AGENT receives — its serialized size, its entry count, and
 * whether `truncated` admits the roster was cut — across the limits a caller can ask for.
 */
describe('parley_list_users bounds the roster it hands the agent', () => {
  /** One maximal entry's legal serialization: topics AND postTopics, capped in count and in length. */
  const ENTRY_BYTES = 2 * MAX_RECORD_TOPICS * (MAX_TOPIC_LEN + 8) + 512;
  const filler = (tag: string): string => tag.padEnd(MAX_TOPIC_LEN, 'y');

  /** One credential, PRESENCE_FETCH_LIMIT distinct self-reported peers, each maximally verbose. */
  async function floodDistinctPeers(plugin: FakePlugin): Promise<void> {
    const at = Date.now();
    const topics = ['ctx', ...Array.from({ length: MAX_RECORD_TOPICS - 1 }, (_u, j) => filler(`t-${j}-`))];
    const postTopics = Array.from({ length: MAX_RECORD_TOPICS }, (_u, j) => filler(`p-${j}-`));
    for (let i = 0; i < PRESENCE_FETCH_LIMIT; i++) {
      await plugin.post(
        PRESENCE_TOPIC,
        asHandle('one-credential'),
        encodePresence({
          v: 2,
          kind: 'heartbeat',
          at,
          handle: `peer-${i}`,
          topics,
          postTopics,
          instanceId: `inst-${i}`,
        }),
      );
    }
  }

  it.each([
    ['no limit asked for', undefined, DEFAULT_ROSTER_LIMIT],
    ['a limit below the default', 5, 5],
    ['a limit above the roster cap', 10_000, MAX_ROSTER_ENTRIES],
  ])('%s', async (_name, limit, expectedMax) => {
    const { client, plugin } = await harness({ topics: ['ctx'] });
    await floodDistinctPeers(plugin);
    const res = (await client.callTool({
      name: 'parley_list_users',
      arguments: limit === undefined ? {} : { limit },
    })) as ToolText;
    const text = res.content[0]!.text;
    const out = JSON.parse(text) as RosterResult;

    expect(out.users.length).toBeGreaterThan(0); // bounded, never emptied
    expect(out.users.length).toBeLessThanOrEqual(expectedMax);
    expect(text.length).toBeLessThan((expectedMax + 1) * ENTRY_BYTES);
    expect(out.truncated).toBe(true);
  });

  it('a limit that cuts a roster the page could hold in full still says truncated', async () => {
    const { client, plugin } = await harness({ topics: ['ctx'] });
    for (const handle of ['claude-a', 'claude-b', 'claude-c']) {
      await postBeat(plugin, handle, ['ctx'], 'heartbeat', Date.now());
    }
    const full = parse(await client.callTool({ name: 'parley_list_users', arguments: {} })) as RosterResult;
    expect(full.users).toHaveLength(3);
    expect(full.truncated).toBe(false); // nothing was cut — the flag is not simply always on

    const cut = parse(
      await client.callTool({ name: 'parley_list_users', arguments: { limit: 2 } }),
    ) as RosterResult;
    expect(cut.users).toHaveLength(2);
    expect(cut.truncated).toBe(true);
  });

  it('the description states the default the handler applies', async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'parley_list_users')!.description!;
    expect(description).toContain(`default ${DEFAULT_ROSTER_LIMIT}`);
  });
});

/**
 * `truncated` is a disjunction of three independent causes the tool description names, and the
 * cases above happen to drive two of them: the roster-entry cap was set by nothing at all, so
 * deleting that clause — or making it the dead `> MAX_ROSTER_ENTRIES`, since computeRoster slices to
 * exactly that length — left the whole suite green while 127 handles were dropped and the agent was
 * told the roster was complete.
 *
 * So table the flag BY CAUSE, one row per cause plus a control, each constructed so exactly one is
 * active — and assert the two inactive ones really are inactive, or a row where two coincide passes
 * for the wrong reason. The description is graded off the same table, so a fourth cause added to the
 * sentence without a row here fails rather than reading as coverage.
 */
describe('every cause of a truncated roster is disclosed, and only when it applies', () => {
  const NOW = 3_000_000;

  interface Cause {
    /** The phrase the tool description uses for this cause. */
    phrase: string;
    beats: number;
    distinctHandles: number;
    limit?: number;
    /** Unreachable peers advertise a full bank of screened-but-costly sources. */
    costlyPatterns?: boolean;
    truncated: boolean;
  }

  const CAUSES: Record<string, Cause> = {
    'the scanned presence history was full': {
      phrase: 'the scanned presence history was full',
      beats: PRESENCE_FETCH_LIMIT,
      distinctHandles: 3,
      truncated: true,
    },
    'the roster hit its entry cap': {
      phrase: 'the roster hit its entry cap',
      beats: MAX_ROSTER_ENTRIES + 2,
      distinctHandles: MAX_ROSTER_ENTRIES + 2,
      truncated: true,
    },
    '`limit` trimmed it': {
      phrase: '`limit` trimmed it',
      beats: 3,
      distinctHandles: 3,
      limit: 2,
      truncated: true,
    },
    'matching peers’ advertised patterns hit its CPU allowance and left some peers unmatched': {
      phrase: 'matching peers’ advertised patterns hit its CPU allowance and left some peers unmatched',
      // Under every other cause's threshold, so this row grades its own clause and no neighbour's.
      beats: MAX_ROSTER_ENTRIES - 8,
      distinctHandles: MAX_ROSTER_ENTRIES - 8,
      costlyPatterns: true,
      truncated: true,
    },
    'none of them': { phrase: '', beats: 3, distinctHandles: 3, truncated: false },
  };

  /**
   * `beats` presence messages from `distinctHandles` handles, of which only the first three sit on
   * a topic this bridge shares — so the roster fills while the reachable answer stays small, and
   * `limit` cannot be what cut it. Reachable peers beat LAST so the roster-cap slice keeps them.
   */
  async function serveBeats(plugin: FakePlugin, cause: Cause): Promise<void> {
    const reachable = Math.min(3, cause.distinctHandles);
    for (let i = 0; i < cause.beats; i++) {
      const handle = `peer-${i % cause.distinctHandles}`;
      const shared = i % cause.distinctHandles < reachable;
      await postBeat(
        plugin,
        handle,
        [shared ? 'ctx' : 'their-own-topic'],
        'heartbeat',
        NOW - (cause.beats - i),
        cause.costlyPatterns === true && !shared ? costlyBank(i) : [],
        `inst-${i % cause.distinctHandles}`,
      );
    }
  }

  it.each(Object.entries(CAUSES))('%s', async (_label, cause) => {
    const { client, plugin } = await harness({ topics: ['ctx'], now: () => NOW });
    await serveBeats(plugin, cause);
    const out = parse(
      await client.callTool({
        name: 'parley_list_users',
        arguments: cause.limit === undefined ? {} : { limit: cause.limit },
      }),
    ) as RosterResult;

    // Exactly one cause is live in this row — assert the other two are not, so a coincidence
    // cannot stand in for the clause the row is here to grade.
    expect(cause.beats >= PRESENCE_FETCH_LIMIT).toBe(cause.phrase === 'the scanned presence history was full');
    expect(cause.distinctHandles >= MAX_ROSTER_ENTRIES).toBe(cause.phrase === 'the roster hit its entry cap');
    expect(out.users.length === (cause.limit ?? DEFAULT_ROSTER_LIMIT)).toBe(cause.phrase === '`limit` trimmed it');
    expect(cause.costlyPatterns === true).toBe(cause.phrase.startsWith('matching peers'));
    expect(out.users.length).toBeGreaterThan(0);
    expect(out.truncated).toBe(cause.truncated);
  });

  it('the description names these causes and no others', async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'parley_list_users')!.description!;
    const named = /truncated=true \(?when the answer was cut — (.*?) — so peers may be missing/
      .exec(description)?.[1]
      ?.split(/,\s*(?:or\s+)?/);
    expect(named).toEqual(Object.values(CAUSES).map((c) => c.phrase).filter((p) => p !== ''));
  });
});

/**
 * `limit` is a maximum the seam only ASKS for — a plugin may hand back more, and
 * `testing/nonconformant.ts` models exactly that shape. The roster's own caps bound what the AGENT
 * sees, so an over-long page costs nothing visible: it is paid entirely in decode work, one
 * `JSON.parse` per beat, invisible to any assertion about the answer. Grade the COST, across pages
 * that sit under, on, and well over the limit, and pin WHICH end of the page survives the trim —
 * a clamp keeping the wrong end reads identically in every count.
 */
describe('parley_list_users bounds the decode work an over-serving plugin can impose', () => {
  const NOW = 2_000_000;

  /** `n` well-formed beats, oldest first, each from its own handle so the roster keeps them apart. */
  function presencePage(n: number): Message[] {
    return Array.from({ length: n }, (_u, i) => ({
      topic: PRESENCE_TOPIC,
      senderHandle: asHandle('one-credential'),
      content: encodePresence({
        v: 2,
        kind: 'heartbeat',
        at: NOW - (n - i) * 10,
        handle: `peer-${i}`,
        topics: ['ctx'],
        postTopics: [],
        instanceId: `inst-${i}`,
      }),
      timestamp: new Date(NOW).toISOString(),
      backendMsgId: asBackendMsgId(String(i)),
      cursor: asCursor(String(i)),
      mentions: [],
    }));
  }

  it.each([
    ['a page under the limit', PRESENCE_FETCH_LIMIT - 1],
    ['a page exactly at the limit', PRESENCE_FETCH_LIMIT],
    ['a page one beat over the limit', PRESENCE_FETCH_LIMIT + 1],
    ['a page many times the limit', PRESENCE_FETCH_LIMIT * 3],
  ])('%s costs at most one decode per retained beat', async (_name, pageSize) => {
    const { client, plugin } = await harness({ topics: ['ctx'], now: () => NOW });
    const page = presencePage(pageSize);
    plugin.fetchRecent = async (): Promise<FetchRecentResult> => ({
      messages: page,
      nextCursor: asCursor(String(pageSize)),
    });

    const parses = vi.spyOn(JSON, 'parse');
    const res = await client.callTool({ name: 'parley_list_users', arguments: {} });
    const decoded = parses.mock.calls.filter(
      ([text]) => typeof text === 'string' && text.includes('"kind"'),
    ).length;
    parses.mockRestore();

    expect(decoded).toBe(Math.min(pageSize, PRESENCE_FETCH_LIMIT));
    // The FRESHEST end is what a roster is for: the newest beat must survive, the oldest must not
    // once the page over-serves. Both hold for every page size, over-long or not.
    const out = parse(res) as RosterResult;
    expect(out.users[0]!.handle).toBe(`peer-${pageSize - 1}`);
    expect(out.users.map((u) => u.handle)).not.toContain('peer-0');
  });
});

/**
 * A budget is a caller-facing predicate an untrusted COUNT can switch off. `filterReachable` spends
 * a per-call CPU allowance matching untrusted peer patterns; the entry count and every entry's
 * position in the recency sort are chosen by whoever writes the beats, so a page of legal-but-costly
 * beats could spend the whole allowance and every peer behind it was reported unreachable — while
 * `truncated` still answered `false`, which an agent reads as "that is the whole bus".
 *
 * Grade the CLASS: a peer that IS reachable is either returned or the answer says it was cut. Never
 * silently dropped. The pressure is DERIVED from the caps that create it, so widening
 * MAX_RECORD_TOPICS or MAX_AMBIGUITY re-derives a hostile page rather than leaving a hard-coded one
 * that no longer costs anything.
 */
describe('a hostile presence page cannot silently delete a reachable peer', () => {
  const NOW = 2_000_000;
  const TTL = 90_000;
  /** A long subscribed topic: matching cost is per input character, and this is what peers match. */
  const MINE = `ctx-${'a'.repeat(56)}`;
  /** Enough hostile entries to outspend the allowance, sized off the roster cap that admits them. */
  const HOSTILE_ENTRIES = Math.floor(MAX_ROSTER_ENTRIES / 4);

  type Direction = 'inbound' | 'outbound' | 'both';
  type Position = 'first' | 'middle' | 'last';
  type Reach = 'explicit shared topic' | 'pattern-only';

  const DIRECTIONS: Direction[] = ['inbound', 'outbound', 'both'];
  const POSITIONS: Position[] = ['first', 'middle', 'last'];
  const REACHES: Reach[] = ['explicit shared topic', 'pattern-only'];

  const CELLS = DIRECTIONS.flatMap((direction) =>
    POSITIONS.flatMap((position) => REACHES.map((reach) => ({ direction, position, reach }))),
  );

  it.each(CELLS.map((c) => [`${c.direction} inflated, benign ${c.position}, ${c.reach}`, c] as const))(
    '%s',
    async (_label, cell) => {
      // My own post_topics are what an OUTBOUND-inflated page makes me spend, so they have to be
      // the same shape of screened-but-costly source a real operator may legally configure.
      const h = await harness({
        now: () => NOW,
        presenceTtlMs: TTL,
        topics: [MINE],
        postPatterns: costlyBank(9_000).slice(0, MAX_POST_TOPICS),
      });

      const benignIndex =
        cell.position === 'first' ? 0 : cell.position === 'last' ? HOSTILE_ENTRIES : HOSTILE_ENTRIES >> 1;

      // Freshest beats sort first, so `ago` decides where the benign peer lands in the scan.
      let slot = 0;
      const at = (): number => NOW - 1_000 - slot++ * 10;
      for (let i = 0; i <= HOSTILE_ENTRIES; i++) {
        if (i === benignIndex) {
          const topics = cell.reach === 'explicit shared topic' ? [MINE] : ['their-own-ctx'];
          const patterns = cell.reach === 'pattern-only' ? ['ctx-.*'] : [];
          await postBeat(h.plugin, 'colleague', topics, 'hello', at(), patterns);
          continue;
        }
        const topics = cell.direction === 'inbound' ? ['their-own-ctx'] : costlyBank(i);
        const patterns = cell.direction === 'outbound' ? [] : costlyBank(1_000 + i);
        await postBeat(h.plugin, `hostile-${i}`, topics, 'hello', at(), patterns);
      }

      const out = parse(
        await h.client.callTool({ name: 'parley_list_users', arguments: { limit: MAX_ROSTER_ENTRIES } }),
      ) as RosterResult;
      const returned = out.users.some((u) => u.handle === 'colleague');
      expect(
        returned || out.truncated,
        'colleague is reachable, yet the roster neither carries it nor admits it was cut',
      ).toBe(true);
    },
  );

  // Fair share bounds what a SUBSET can spend; a page that fills the roster leaves nothing for
  // anyone, and then the only thing standing between the agent and "nobody is on the bus" is the
  // answer saying it was cut. Sized under every OTHER cause of `truncated` — below the roster entry
  // cap, below the presence page limit, and under the requested `limit` — so only the allowance can
  // set it.
  it('a page that saturates the allowance says the roster was cut, not that the bus is empty', async () => {
    const entries = MAX_ROSTER_ENTRIES - 8;
    const h = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: [MINE] });
    for (let i = 0; i < entries; i++) {
      await postBeat(h.plugin, `hostile-${i}`, ['their-own-ctx'], 'hello', NOW - 1_000 - i * 10, costlyBank(i));
    }
    await postBeat(h.plugin, 'colleague', ['their-own-ctx'], 'hello', NOW - 90_000 + 1, ['ctx-.*']);
    const out = parse(
      await h.client.callTool({ name: 'parley_list_users', arguments: { limit: MAX_ROSTER_ENTRIES } }),
    ) as RosterResult;
    expect(out.users.length, 'another cause of truncation would mask the one under test').toBeLessThan(
      MAX_ROSTER_ENTRIES,
    );
    expect(
      out.users.some((u) => u.handle === 'colleague') || out.truncated,
      'colleague is reachable, yet the roster neither carries it nor admits it was cut',
    ).toBe(true);
  });

  // Disclosure alone would satisfy the table above while every legitimate peer still vanished. The
  // allowance is therefore shared across the entries REMAINING, so a hostile subset spends its own
  // slice and no more: a peer behind it keeps enough allowance to be matched, and stays visible.
  it('a hostile subset spends only its share, so the peer behind it is RETURNED', async () => {
    // ONE entry's full bank of costly sources already outspends the allowance several times over,
    // so a handful is a saturating prefix — and a handful is all the overrun a slow machine can
    // add, which keeps this a statement about the sharing rule rather than about the clock.
    const prefix = 4;
    const h = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: [MINE] });
    for (let i = 0; i < prefix; i++) {
      await postBeat(h.plugin, `hostile-${i}`, ['their-own-ctx'], 'hello', NOW - 1_000 - i * 10, costlyBank(i));
    }
    await postBeat(h.plugin, 'colleague', ['their-own-ctx'], 'hello', NOW - 90_000 + 1, ['ctx-.*']);
    const out = parse(
      await h.client.callTool({ name: 'parley_list_users', arguments: { limit: MAX_ROSTER_ENTRIES } }),
    ) as RosterResult;
    expect(
      out.users.map((u) => u.handle),
      'the hostile prefix spent the allowance the peer behind it needed',
    ).toContain('colleague');
  });

  it('a benign page of the same size is neither clipped nor reported truncated', async () => {
    const h = await harness({ now: () => NOW, presenceTtlMs: TTL, topics: [MINE] });
    for (let i = 0; i <= HOSTILE_ENTRIES; i++) {
      await postBeat(h.plugin, `peer-${i}`, ['their-own-ctx'], 'hello', NOW - 1_000 - i * 10, ['ctx-.*']);
    }
    const out = parse(
      await h.client.callTool({ name: 'parley_list_users', arguments: { limit: MAX_ROSTER_ENTRIES } }),
    ) as RosterResult;
    expect(out.users).toHaveLength(HOSTILE_ENTRIES + 1);
    expect(out.truncated, 'nothing was cut, so nothing should say it was').toBe(false);
  });
});
