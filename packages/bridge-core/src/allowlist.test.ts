import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { Allowlist, allowlistFor, TopicNotAllowedError, UnsafePatternError } from './allowlist.js';
import { MAX_POST_TOPICS, parseConfig } from './config.js';
import { encodePresence } from './engine/presence.js';
import { asHandle, type Topic } from './message.js';
import { MAX_MATCH_INPUT } from './regex-safety.js';
import { FakePlugin } from './testing/fake-plugin.js';
import { registerTools, toolDepsFor } from './transport/tools.js';

function compiles(src: string): boolean {
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
}

describe('Allowlist', () => {
  const allow = new Allowlist(['ctx-payments', 'ctx-payments-reviews']);

  it('allows listed topics and brands them', () => {
    expect(allow.has('ctx-payments')).toBe(true);
    expect(allow.assert('ctx-payments')).toBe('ctx-payments');
  });

  it('rejects unlisted topics with TopicNotAllowedError', () => {
    expect(allow.has('secret')).toBe(false);
    expect(() => allow.assert('secret')).toThrow(TopicNotAllowedError);
  });

  it('exposes the branded topic set for subscribe', () => {
    expect(allow.topics().sort()).toEqual(['ctx-payments', 'ctx-payments-reviews']);
  });

  it('exposes no patterns by default', () => {
    expect(allow.patterns()).toEqual([]);
  });
});

describe('Allowlist post patterns', () => {
  const allow = new Allowlist(['ctx-a'], { postPatterns: ['ctx-.*', 'exp/[a-z]+'] });

  it('accepts a pattern-matched topic for post/fetch (full-match anchored)', () => {
    expect(allow.has('ctx-anything')).toBe(true);
    expect(allow.assert('exp/beta')).toBe('exp/beta');
  });

  it('anchors patterns — a partial match does not pass', () => {
    expect(allow.has('x-ctx-a')).toBe(false);
    expect(allow.has('ctx-a-suffix')).toBe(true); // ctx-.* still matches this
    expect(allow.has('exp/Beta')).toBe(false); // [a-z]+ excludes uppercase
  });

  it('does NOT widen the explicit topic set (subscribe/catch-up stay exact)', () => {
    expect(allow.topics()).toEqual(['ctx-a']);
  });

  it('round-trips the raw pattern sources', () => {
    expect(allow.patterns()).toEqual(['ctx-.*', 'exp/[a-z]+']);
  });
});

describe('Allowlist reserved topics', () => {
  it('refuses a reserved topic on post/fetch even when a pattern would match it', () => {
    const allow = new Allowlist(['ctx-a'], {
      postPatterns: ['.*'],
      reserved: ['parley-presence'],
    });
    expect(allow.has('parley-presence')).toBe(false);
    expect(() => allow.assert('parley-presence')).toThrow(TopicNotAllowedError);
    expect(allow.has('ctx-a')).toBe(true); // the broad pattern still allows non-reserved topics
  });

  it('throws when an explicit topic is also reserved (config error)', () => {
    expect(() => new Allowlist(['parley-presence'], { reserved: ['parley-presence'] })).toThrow(
      TopicNotAllowedError,
    );
  });

  // The over-long refusal and its message are graded at the clamp itself in stated-bounds.test.ts.
  it('refuses an unmatched topic without inventing a reason', () => {
    const allow = new Allowlist(['ctx'], { postPatterns: ['ctx-.*'] });
    expect(() => allow.assert('nope')).toThrow(/^topic not allowed: "nope"$/);
  });
});

// `allowlistFor` is the one function that turns a parsed config into the runtime security boundary,
// and every composition root calls it. The class-level cases above hand `reserved`/`postPatterns` in
// by hand, so none of them can see a wiring mistake HERE — dropping `reserved`, or folding
// `post_topics` into the explicit set, changes nothing they assert. Drive it from parseConfig output
// only, and grade the three-way partition as a property of each row, so a config field added later
// (a second reserved topic, a `subscribe_topics` list) is graded the moment it appears.
describe('allowlistFor wires a parsed config to the boundary', () => {
  const ROWS: readonly (readonly [
    label: string,
    raw: Record<string, unknown>,
    patternHit: string | undefined,
  ])[] = [
    ['no patterns', { topics: ['ctx-a', 'ctx-b'] }, undefined],
    ['one pattern', { topics: ['ctx-a'], post_topics: ['ctx-.*'] }, 'ctx-zzz'],
    ['broad pattern', { topics: ['ctx-a'], post_topics: ['.*'] }, 'anything-at-all'],
    [
      'several patterns',
      { topics: ['ctx-a', 'ctx-b'], post_topics: ['ops-.*', 'dev-[a-z]+'] },
      'dev-x',
    ],
    [
      'custom presence topic under a broad pattern',
      { topics: ['ctx-a'], post_topics: ['.*'], presence: { topic: 'roster-x' } },
      'anything-at-all',
    ],
    [
      'presence disabled under a broad pattern',
      { topics: ['ctx-a'], post_topics: ['.*'], presence: { enabled: false } },
      'anything-at-all',
    ],
  ] as const;

  const configOf = (raw: Record<string, unknown>): ReturnType<typeof parseConfig> =>
    parseConfig({ identity: { handle: 'h' }, ...raw });

  const patternsOf = (raw: Record<string, unknown>): string[] =>
    (raw.post_topics as string[] | undefined) ?? [];

  it('covers rows that can see each wiring mistake', () => {
    expect(ROWS.map(([label]) => label)).toEqual([
      'no patterns',
      'one pattern',
      'broad pattern',
      'several patterns',
      'custom presence topic under a broad pattern',
      'presence disabled under a broad pattern',
    ]);
    expect(ROWS.filter(([, raw]) => patternsOf(raw).length > 0).length).toBeGreaterThanOrEqual(4);
    expect(ROWS.filter(([, raw]) => patternsOf(raw).includes('.*')).length).toBeGreaterThanOrEqual(
      3,
    );
    expect(ROWS.filter(([, , hit]) => hit !== undefined).length).toBeGreaterThanOrEqual(4);
  });

  it.each(ROWS)('subscribe sees exactly the explicit topics (%s)', (_label, raw) => {
    const cfg = configOf(raw);
    expect([...allowlistFor(cfg).topics()].sort()).toEqual([...cfg.topics].sort());
  });

  it.each(ROWS)('the presence topic is reserved on both dimensions (%s)', (_label, raw) => {
    const cfg = configOf(raw);
    const allow = allowlistFor(cfg);
    expect(allow.has(cfg.presence.topic)).toBe(false);
    expect(() => allow.assert(cfg.presence.topic)).toThrow(TopicNotAllowedError);
    expect(allow.topics()).not.toContain(cfg.presence.topic);
  });

  it.each(ROWS)('a pattern match is postable but never subscribed (%s)', (_label, raw, hit) => {
    const cfg = configOf(raw);
    const allow = allowlistFor(cfg);
    expect(allow.patterns()).toEqual(cfg.post_topics);
    if (hit === undefined) return;
    expect(allow.has(hit)).toBe(true);
    expect(allow.topics()).not.toContain(hit);
  });
});

// `Allowlist` is public API: an embedder can construct one with patterns that never went through
// parseConfig, and `has` is then driven by a caller-supplied topic. Screen at BOTH ends — refuse
// the hostile source at construction, and bound the input the survivors ever see.
describe('Allowlist pattern safety', () => {
  // Which sources the constructor refuses is graded against the shared hostile/safe corpus, at every
  // layer that compiles an unauthored pattern, in regex-screen-parity.test.ts.
  it('refuses an unsafe source with UnsafePatternError, naming the pattern', () => {
    expect(() => new Allowlist(['ctx'], { postPatterns: ['([a-z]+)+'] })).toThrow(
      UnsafePatternError,
    );
    expect(() => new Allowlist(['ctx'], { postPatterns: ['([a-z]+)+'] })).toThrow(/\(\[a-z\]\+\)\+/);
  });

  // Two axes: pattern shape × topic length, each at a topic the pattern DOES match and one it does
  // not. A table of non-matching topics grades only the clamp, and the verdict is derived from
  // MAX_MATCH_INPUT rather than pinned false everywhere, so a clamp that swallowed a legal topic
  // (or a pattern that stopped matching) reddens here rather than shipping.
  const LENGTHS = [1, 8, 32, 63, MAX_MATCH_INPUT, MAX_MATCH_INPUT + 1, 256, 5000];
  const SAFE: readonly (readonly [string, string, (len: number) => string | undefined])[] = [
    ['plain broad pattern', 'ctx-.*', (len) => (len >= 4 ? `ctx-${'a'.repeat(len - 4)}` : undefined)],
    [
      'character class',
      'project-[a-z0-9-]+',
      (len) => (len >= 9 ? `project-${'a'.repeat(len - 8)}` : undefined),
    ],
    ['alternation', '(alpha|beta)-.*', (len) => (len >= 5 ? `beta-${'a'.repeat(len - 5)}` : undefined)],
    [
      'bounded repeat',
      'ctx-\\d{1,4}',
      (len) => (len >= 5 && len <= 8 ? `ctx-${'1'.repeat(len - 4)}` : undefined),
    ],
    ['four unbounded quantifiers', '.*.*.*.*x', (len) => `${'a'.repeat(len - 1)}x`],
  ] as const;

  const MATCH_ROWS = SAFE.flatMap(([label, pattern, matching]) =>
    LENGTHS.flatMap((len) => {
      const hit = matching(len);
      const rows: [string, string, string, boolean][] = [
        [`${label} @ ${len} (no match)`, pattern, `${'a'.repeat(len - 1)}!`, false],
      ];
      if (hit !== undefined)
        rows.push([`${label} @ ${len} (match)`, pattern, hit, len <= MAX_MATCH_INPUT]);
      return rows;
    }),
  );

  it('covers both verdicts on both sides of the clamp', () => {
    expect(MATCH_ROWS.filter(([, , , expected]) => expected).length).toBeGreaterThan(15);
    expect(MATCH_ROWS.filter(([label]) => label.includes('(match)')).length).toBeGreaterThan(25);
    expect(MATCH_ROWS.every(([, , topic]) => topic.length > 0)).toBe(true);
  });

  it.each(MATCH_ROWS)(
    'bounds match work and answers correctly (%s)',
    (_label, pattern, topic, expected) => {
      const allow = new Allowlist(['ctx'], { postPatterns: [pattern] });
      const started = Date.now();
      expect(allow.has(topic)).toBe(expected);
      expect(Date.now() - started).toBeLessThan(100);
    },
  );

  // The wrapper is `^(?:src)$`, not `^src$`, and the group is what makes the anchors bind the WHOLE
  // source. Every alternation in the shared corpus is already parenthesised, which is exactly the
  // shape the group is redundant for, so nothing there can tell the two wrappers apart. A source
  // whose TOP level is an alternation or an anchor can: under `^src$` a config line reading as two
  // narrow topics mints a post/fetch set reaching arbitrary topics. The mustNotMatch column is what
  // pins it — a row asserting only that the listed topic matches cannot fail.
  const ANCHORING: readonly (readonly [src: string, match: string[], notMatch: string[]])[] = [
    ['ops|dev', ['ops', 'dev'], ['secret-dev', 'ops-anything', 'xops', 'devx']],
    ['a|b|c', ['a', 'b', 'c'], ['ab', 'xa', 'cx']],
    ['|ops', ['ops'], ['secret', 'x-ops']],
    ['ops|', ['ops'], ['secret', 'ops-x']],
    ['ctx-.*|ops', ['ctx-a', 'ops'], ['x-ctx-a', 'opsx']],
    ['^ops', ['ops'], ['ops-x', 'x-ops']],
    ['ops$', ['ops'], ['ops-x', 'x-ops']],
  ] as const;

  const COMPILING_ENTRY_POINTS: readonly (readonly [
    label: string,
    build: (src: string) => Allowlist,
  ])[] = [
    ['new Allowlist({ postPatterns })', (src) => new Allowlist(['ctx'], { postPatterns: [src] })],
    [
      'allowlistFor(parseConfig({ post_topics }))',
      (src) => allowlistFor(parseConfig({ identity: { handle: 'h' }, topics: ['ctx'], post_topics: [src] })),
    ],
  ] as const;

  it('every anchoring row can fail in both directions', () => {
    expect(ANCHORING.length).toBe(7);
    expect(ANCHORING.every(([, match]) => match.length > 0)).toBe(true);
    expect(ANCHORING.every(([, , notMatch]) => notMatch.length > 0)).toBe(true);
    expect(ANCHORING.map(([src]) => src)).toEqual(
      expect.arrayContaining(['ops|dev', '|ops', 'ops|', '^ops', 'ops$']),
    );
  });

  it.each(
    COMPILING_ENTRY_POINTS.flatMap(([entry, build]) =>
      ANCHORING.map(
        ([src, match, notMatch]) =>
          [`${entry} × ${JSON.stringify(src)}`, build, src, match, notMatch] as const,
      ),
    ),
  )('anchors the whole source, not one branch of it (%s)', (_label, build, src, match, notMatch) => {
    const allow = build(src);
    expect(match.filter((t) => !allow.has(t))).toEqual([]);
    expect(notMatch.filter((t) => allow.has(t))).toEqual([]);
  });

  // The constructor validates the bare source but matches with `^(?:src)$`. An unbalanced source is
  // uncompilable alone yet LEGAL once wrapped, because the anchors re-associate into one branch of an
  // unanchored alternation — `ops)|(.*` becomes `/^(?:ops)|(.*)$/`, which matches every topic. So a
  // config line that reads as narrow mints an allow-everything post/fetch set.
  const WRAP_ESCAPING = ['ops)|(.*', 'a)|(.*', 'a)(b', 'x)$|^(', '(a', 'a|b)', ')(', '[a', 'a\\'];

  it.each(WRAP_ESCAPING)('refuses a source that only compiles once wrapped (%s)', (src) => {
    expect(() => new Allowlist(['ctx'], { postPatterns: [src] })).toThrow(SyntaxError);
  });

  it('never widens the post set beyond the source, however the source is shaped', () => {
    const widened = WRAP_ESCAPING.filter((src) => {
      try {
        return new Allowlist(['ctx'], { postPatterns: [src] }).has('secret-topic');
      } catch {
        return false;
      }
    });
    expect(widened).toEqual([]);
  });

  it('refuses more patterns than the collection cap, naming the cap', () => {
    const overCap = Array.from({ length: MAX_POST_TOPICS + 1 }, (_, i) => `ctx-${i}-.*`);
    expect(() => new Allowlist(['ctx'], { postPatterns: overCap })).toThrow(RangeError);
    expect(() => new Allowlist(['ctx'], { postPatterns: overCap })).toThrow(
      new RegExp(`at most ${MAX_POST_TOPICS} post patterns`),
    );
  });

  it('accepts a source only if it compiles on its own', () => {
    const safe = SAFE.map(([, pattern]) => pattern);
    const candidates = [
      ...safe,
      ...safe.flatMap((src) => [src.slice(0, -1), src.slice(0, -2), src.slice(1)]),
      ...WRAP_ESCAPING,
    ].filter((src) => src.length > 0);
    const accepted = candidates.filter((src) => {
      try {
        new Allowlist(['ctx'], { postPatterns: [src] });
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted.filter((src) => !compiles(src))).toEqual([]);
    expect(accepted).toEqual(expect.arrayContaining(safe));
  });
});

// The loader and the runtime gate must not disagree about the same topic STRING. `parseConfig`
// refuses `topics: ['']` on the stated grounds that a field naming something can never be empty, so
// a broad `post_topics` pattern must not admit it one layer down at the boundary DESIGN §14 puts
// there — an empty topic reaches `plugin.post('', …)` and folds to an empty backend channel name
// that no charset check catches. Derive the verdict from parseConfig and the pattern rather than
// pinning it per row, so the two boundaries cannot drift apart again.
describe('the runtime gate never admits a topic the loader forbids', () => {
  const DEGENERATE_TOPICS = [
    '',
    ' ',
    '\t',
    '\n',
    '.',
    '..',
    'a'.repeat(MAX_MATCH_INPUT + 1),
    'parley-presence',
  ];
  const BROAD_PATTERNS = ['.*', '[a-z]*', 'x?', '(?:)', '[\\s\\S]*'];

  const loaderAccepts = (topic: string): boolean => {
    try {
      parseConfig({ identity: { handle: 'h' }, topics: [topic] });
      return true;
    } catch {
      return false;
    }
  };
  const patternMatches = (pattern: string, topic: string): boolean =>
    new RegExp(`^(?:${pattern})$`).test(topic);

  const ROWS = DEGENERATE_TOPICS.flatMap((topic) =>
    BROAD_PATTERNS.map(
      (pattern) =>
        [
          `${JSON.stringify(topic)} under ${JSON.stringify(pattern)}`,
          topic,
          pattern,
          loaderAccepts(topic) && topic.length <= MAX_MATCH_INPUT && patternMatches(pattern, topic),
        ] as const,
    ),
  );

  it('the table can fail in both directions, and on each clause independently', () => {
    expect(DEGENERATE_TOPICS.filter((t) => !loaderAccepts(t))).toEqual(['', 'parley-presence']);
    expect(ROWS.filter(([, , , expected]) => expected).length).toBeGreaterThan(8);
    expect(ROWS.filter(([, , , expected]) => !expected).length).toBeGreaterThan(8);
    // One row per clause of the verdict, so deleting any clause reddens something.
    expect(ROWS.some(([, t, , e]) => t === '' && patternMatches('.*', t) && !e)).toBe(true);
    expect(ROWS.some(([, t, , e]) => t.length > MAX_MATCH_INPUT && !e)).toBe(true);
    expect(ROWS.some(([, t, , e]) => t === 'parley-presence' && !e)).toBe(true);
  });

  it.each(ROWS)('%s', (_label, topic, pattern, expected) => {
    const allow = allowlistFor(
      parseConfig({ identity: { handle: 'h' }, topics: ['ctx'], post_topics: [pattern] }),
    );
    expect(allow.has(topic)).toBe(expected);
    if (expected) expect(allow.assert(topic)).toBe(topic);
    else expect(() => allow.assert(topic)).toThrow(TopicNotAllowedError);
  });

  it('refuses an explicit empty topic at construction, as the loader does', () => {
    expect(() => new Allowlist([''])).toThrow(TopicNotAllowedError);
    expect(() => new Allowlist([''])).toThrow(/never be the empty string/);
  });
});

// Which allowlist DIMENSION each caller-facing surface consults is a claim the class doc makes, and
// it went stale: the doc called the explicit list the default scope of `parley_list_users`, while
// the unscoped roster is the UNION of both dimensions. Assert the dimension by construction through
// the real MCP surfaces, driven from parseConfig via the composition roots' own `toolDepsFor`, so a
// surface that starts consulting a different dimension reddens here. A tool registered without a row
// fails as a missing entry.
describe('each caller-facing surface consults the allowlist dimension its doc names', () => {
  const EXPLICIT_TOPIC = 'ctx-mine';
  const PATTERN_ONLY_TOPIC = 'ctx-adhoc';
  const UNREACHABLE_TOPIC = 'other-x';

  type Dimension = 'EXPLICIT' | 'POST_FETCH' | 'BOTH';

  interface Surface {
    label: string;
    tool?: string;
    dimension: Dimension;
    reaches: (h: Harness, topic: string) => Promise<boolean>;
  }

  interface Harness {
    client: Client;
    allow: ReturnType<typeof allowlistFor>;
    plugin: FakePlugin;
    presenceTopic: Topic;
  }

  const ok = async (client: Client, name: string, args: Record<string, unknown>): Promise<boolean> =>
    ((await client.callTool({ name, arguments: args })) as { isError?: boolean }).isError !== true;

  const rosterHandles = async (client: Client, args: Record<string, unknown>): Promise<string[]> => {
    const res = (await client.callTool({ name: 'parley_list_users', arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    if (res.isError === true) return [];
    return (JSON.parse(res.content[0]!.text) as { users: { handle: string }[] }).users.map(
      (u) => u.handle,
    );
  };

  /** Each peer subscribes to exactly one topic, so its presence in the roster names that topic. */
  const peerOn = (topic: string): string => `peer-${topic}`;

  const SURFACES: Surface[] = [
    {
      label: 'parley_post',
      tool: 'parley_post',
      dimension: 'POST_FETCH',
      reaches: (h, topic) => ok(h.client, 'parley_post', { topic, content: 'x' }),
    },
    {
      label: 'parley_reply',
      tool: 'parley_reply',
      dimension: 'POST_FETCH',
      reaches: (h, topic) => ok(h.client, 'parley_reply', { topic, content: 'x' }),
    },
    {
      label: 'parley_fetch_recent',
      tool: 'parley_fetch_recent',
      dimension: 'POST_FETCH',
      reaches: (h, topic) => ok(h.client, 'parley_fetch_recent', { topic }),
    },
    {
      label: 'parley_list_users scoped',
      tool: 'parley_list_users',
      dimension: 'POST_FETCH',
      reaches: async (h, topic) =>
        (await rosterHandles(h.client, { topic })).includes(peerOn(topic)),
    },
    {
      label: 'parley_list_users unscoped',
      dimension: 'BOTH',
      reaches: async (h, topic) => (await rosterHandles(h.client, {})).includes(peerOn(topic)),
    },
    {
      label: 'subscribe / catch-up',
      dimension: 'EXPLICIT',
      reaches: (h, topic) => Promise.resolve(h.allow.topics().some((t) => t === topic)),
    },
  ];

  const REACHES: Record<Dimension, Record<string, boolean>> = {
    EXPLICIT: { [EXPLICIT_TOPIC]: true, [PATTERN_ONLY_TOPIC]: false, [UNREACHABLE_TOPIC]: false },
    POST_FETCH: { [EXPLICIT_TOPIC]: true, [PATTERN_ONLY_TOPIC]: true, [UNREACHABLE_TOPIC]: false },
    BOTH: { [EXPLICIT_TOPIC]: true, [PATTERN_ONLY_TOPIC]: true, [UNREACHABLE_TOPIC]: false },
  };

  async function harness(): Promise<Harness> {
    const cfg = parseConfig({
      identity: { handle: 'me' },
      topics: [EXPLICIT_TOPIC],
      post_topics: ['ctx-.*'],
    });
    const plugin = new FakePlugin();
    await plugin.connect({});
    const deps = toolDepsFor(plugin, cfg);
    for (const topic of [EXPLICIT_TOPIC, PATTERN_ONLY_TOPIC, UNREACHABLE_TOPIC])
      await plugin.post(
        deps.presenceTopic,
        asHandle(peerOn(topic)),
        encodePresence({
          v: 2,
          kind: 'heartbeat',
          at: Date.now(),
          handle: peerOn(topic),
          topics: [topic],
          postTopics: [],
          instanceId: `i-${topic}`,
        }),
      );
    const server = new McpServer(
      { name: 'parley', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    registerTools(server, deps);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return { client, allow: deps.allow, plugin, presenceTopic: deps.presenceTopic };
  }

  it('every registered tool has a row naming the dimension it consults', async () => {
    const h = await harness();
    const registered = (await h.client.listTools()).tools.map((t) => t.name).sort();
    const covered = [...new Set(SURFACES.flatMap((s) => (s.tool === undefined ? [] : [s.tool])))];
    expect(registered.filter((n) => !covered.includes(n))).toEqual([]);
    expect(new Set(SURFACES.map((s) => s.dimension))).toEqual(
      new Set<Dimension>(['EXPLICIT', 'POST_FETCH', 'BOTH']),
    );
  });

  it.each(
    SURFACES.flatMap((s) =>
      [EXPLICIT_TOPIC, PATTERN_ONLY_TOPIC, UNREACHABLE_TOPIC].map(
        (topic) => [`${s.label} → ${topic} (${s.dimension})`, s, topic] as const,
      ),
    ),
  )('%s', async (_label, surface, topic) => {
    const h = await harness();
    expect(await surface.reaches(h, topic)).toBe(REACHES[surface.dimension][topic]);
  });

  // The other half of the union: a peer I cannot post to, but who advertises a post pattern reaching
  // a topic I subscribe to, is unscoped-reachable through the EXPLICIT dimension alone.
  it('the unscoped roster includes a peer reachable only inbound', async () => {
    const h = await harness();
    await h.plugin.post(
      h.presenceTopic,
      asHandle('peer-inbound'),
      encodePresence({
        v: 2,
        kind: 'heartbeat',
        at: Date.now(),
        handle: 'peer-inbound',
        topics: ['their-private'],
        postTopics: ['ctx-.*'],
        instanceId: 'i-inbound',
      }),
    );
    expect(await rosterHandles(h.client, {})).toContain('peer-inbound');
    expect(await rosterHandles(h.client, {})).not.toContain(peerOn(UNREACHABLE_TOPIC));
  });
});
