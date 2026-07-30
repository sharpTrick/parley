import { loadConfig } from '@sharptrick/parley-core';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROOM_PRESETS, type MatrixBackendConfig } from '../src/index.js';
import { SHAPES } from './cursor-shapes.js';

/**
 * Four CLASSES over what this package ships — to an operator, and to CI.
 *
 *  1. A shipped example config is executable, not illustrative. The multi-session page insists each
 *     session use a DIFFERENT Matrix account, and the default preset makes every provisioned room
 *     invite-only — so a set of configs that share a ROOM without inviting each other deploys to a
 *     system where only whichever session created the room works. That is checkable with no
 *     homeserver: it is a property of the three files.
 *  4. Every cursor FORM the plugin emits is documented where a reader looks it up — the package
 *     README and DESIGN §6's Matrix row both — so a `read-state.json` never holds a value the
 *     source of truth does not list.
 *  2. Every value a config union accepts is documented. A `room_preset` member absent from the
 *     README's config table is a privilege-granting option an operator meets only in the type.
 *  3. A CI step gated on `--if-present` covers a package only if that package opts in. CI runs
 *     `npm run typecheck:test --workspaces --if-present` on the stated grounds that otherwise "no
 *     fixture in the repo is ever seen by a compiler" — a package with test sources and no such
 *     script is silently skipped, and vitest transpiles without type-checking, so the
 *     private-internals casts these fixtures rely on can go stale against a renamed field and keep
 *     grading nothing.
 */

const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
const EXAMPLES = new URL('../../../examples/multi-session/matrix/', import.meta.url);

interface ShippedConfig {
  file: string;
  topics: string[];
  /** Every room this bridge WRITES to — its listed topics plus the presence topic it beats on. */
  writes: string[];
  backend: MatrixBackendConfig;
}

// Loaded through core's own `loadConfig`, so a config that would not even parse in production — or
// that fails the schema — fails here rather than being read past by a bespoke parser. The write set
// comes from the same load, so a reserved or derived topic core adds later is graded the day it
// appears rather than the day an operator's roster goes quiet.
const configs: ShippedConfig[] = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith('.yaml'))
  .map((file) => {
    const doc = loadConfig(fileURLToPath(new URL(file, EXAMPLES)));
    const topics = doc.topics.map(String);
    return {
      file,
      topics,
      writes: [...topics, ...(doc.presence.enabled ? [String(doc.presence.topic)] : [])],
      backend: doc.backend_config as MatrixBackendConfig,
    };
  });

const mxidOf = (c: ShippedConfig): string => `@${c.backend.user}:${c.backend.server_name}`;

describe('the shipped multi-session configs deploy as documented', () => {
  it('finds the example configs it is meant to grade', () => {
    expect(configs.map((c) => c.file).length).toBeGreaterThan(2);
  });

  it.each(configs.map((c): [string, ShippedConfig] => [c.file, c]))(
    '%s: names an account and the fields that must agree',
    (_file, c) => {
      expect(c.backend.user).toBeTruthy();
      expect(c.backend.server_name).toBe(configs[0]!.backend.server_name);
      expect(c.backend.homeserver_url).toBe(configs[0]!.backend.homeserver_url);
      expect(c.backend.shared_room).toBeUndefined(); // production is one room per topic
    },
  );

  it('every account is distinct, as the README requires', () => {
    const users = configs.map((c) => c.backend.user);
    expect(new Set(users).size).toBe(users.length);
  });

  /**
   * Any of them may be the first to post to a shared room, and the creator's `invite` is the only
   * thing that admits the rest — so the requirement is symmetric, not "somebody invites everybody".
   * Graded over every room a config WRITES to rather than over its listed `topics`: the presence
   * topic is a room every presence-enabled bridge posts to and no config lists, so a fleet with
   * disjoint topics still meets there — and the beat that 403s is swallowed by the presence loop,
   * leaving that session absent from every peer's roster with no operator signal at all.
   */
  const sharedRooms = (a: ShippedConfig, b: ShippedConfig): string[] =>
    a.writes.filter((t) => b.writes.includes(t));

  it('the write set covers a room no config lists as a topic', () => {
    const listed = new Set(configs.flatMap((c) => c.topics));
    expect(configs.flatMap((c) => c.writes.filter((t) => !listed.has(t)))).not.toEqual([]);
  });

  it.each(
    configs.flatMap((creator) =>
      configs
        .filter((peer) => peer !== creator && sharedRooms(creator, peer).length > 0)
        .map((peer): [string, ShippedConfig, ShippedConfig] => [
          `${creator.file} writes to ${sharedRooms(creator, peer).join(', ')} with ${peer.file}`,
          creator,
          peer,
        ]),
    ),
  )('%s, so it invites it', (_name, creator, peer) => {
    expect(creator.backend.invite ?? []).toContain(mxidOf(peer));
  });
});

describe('every room_preset the config accepts is in the README config table', () => {
  const table = README.split('\n').filter((l) => l.startsWith('|'));

  it.each(ROOM_PRESETS)('%s', (preset) => {
    expect(table.join('\n')).toContain(`\`${preset}\``);
  });

  it('names the preset it deliberately refuses, so the omission reads as a decision', () => {
    expect(README).toContain('trusted_private_chat');
    expect(ROOM_PRESETS as readonly string[]).not.toContain('trusted_private_chat');
  });
});

/**
 * DESIGN §6's per-backend row is where a reader of a `read-state.json` — or an author of core-side
 * tooling — learns what a Matrix cursor is. A form only the package README knows about is a value
 * that document does not admit exists; a form only DESIGN knows about is one this package's own
 * users never meet. Graded off {@link SHAPES}, so the next form added is graded the day it is added.
 */
const DESIGN = readFileSync(fileURLToPath(new URL('../../../DESIGN.md', import.meta.url)), 'utf8');

/** The `- Matrix → …` bullet of DESIGN §6, continuation lines included, and nobody else's row. */
const designMatrixRow = (): string => {
  const section = DESIGN.split(/^## /m).find((s) => s.startsWith('6.'));
  const lines = (section ?? '').split('\n');
  const start = lines.findIndex((l) => /^\s*- Matrix →/.test(l));
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\s*- \S+ →/.test(l));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
};

describe('every cursor form the plugin emits is documented where a reader looks it up', () => {
  it('finds the DESIGN row it is meant to grade', () => {
    expect(designMatrixRow()).toContain('Matrix →');
  });

  const documented = Object.entries(SHAPES).filter(([, shape]) => 'marker' in shape);

  it('grades at least the two forms this plugin mints', () => {
    expect(documented).toHaveLength(2);
  });

  it.each(documented)('%s', (_name, shape) => {
    const marker = (shape as { marker: string }).marker;
    expect(README).toContain(marker);
    expect(designMatrixRow()).toContain(marker);
  });
});

describe('CI type-checks this package’s test sources rather than skipping it', () => {
  const PKG_ROOT = new URL('../', import.meta.url);
  const read = (name: string): unknown =>
    JSON.parse(readFileSync(fileURLToPath(new URL(name, PKG_ROOT)), 'utf8'));

  const pkg = read('package.json') as { scripts?: Record<string, string> };
  const script = pkg.scripts?.['typecheck:test'];

  it('declares the script the --if-present CI step looks for', () => {
    expect(script).toBeDefined();
  });

  it('points that script at a tsconfig whose include covers every test source', () => {
    const configFile = /(?:-p|--project)\s+(\S+)|\b(tsconfig\.\w+\.json)\b/.exec(script ?? '');
    const named = configFile?.[1] ?? configFile?.[2];
    expect(named, `typecheck:test does not name a tsconfig: ${String(script)}`).toBeDefined();

    const project = read(named!) as { include?: string[] };
    const testSources = readdirSync(fileURLToPath(new URL('test/', PKG_ROOT))).filter((f) =>
      f.endsWith('.ts'),
    );
    expect(testSources.length).toBeGreaterThan(0);
    expect(project.include).toContain('test/**/*');
  });
});

/**
 * CLASS: a per-backend README describing CORE-owned tool semantics. `block_ms`, the `since`
 * convention, the absent-topic answer and the `catchup.block_max_ms` clamp are all owned by
 * `@sharptrick/parley-core` — the plugin never sees the tool surface — and this is the only backend
 * README that adds sentences of its own about them. A claim here can therefore contradict the
 * description core actually ships to the model, and the model believes the tool.
 *
 * Each row pins BOTH sides: the string core ships (so a reworded core description fails here rather
 * than diverging in one package unnoticed) and what this README must, and must not, say about it.
 */
const CORE_SOURCES: Record<string, string> = {
  'transport/tools.ts': readFileSync(
    fileURLToPath(new URL('../../bridge-core/src/transport/tools.ts', import.meta.url)),
    'utf8',
  ),
  'config.ts': readFileSync(
    fileURLToPath(new URL('../../bridge-core/src/config.ts', import.meta.url)),
    'utf8',
  ),
};
const PLUGIN_SRC = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');

interface CoreOwnedClaim {
  /** The string core ships, and where. */
  core: { file: keyof typeof CORE_SOURCES; pattern: RegExp };
  /** What this README must say about it. */
  readme: RegExp;
  /** What it must NOT say: the contradiction this class exists to catch. */
  forbidden?: RegExp;
  /** A plugin-source fact the README's claim rests on. */
  pluginMustNotMatch?: RegExp;
}

const CORE_OWNED_CLAIMS: Record<string, CoreOwnedClaim> = {
  'block_ms holds an EMPTY window, with or without a since': {
    core: { file: 'transport/tools.ts', pattern: /If the queried window is empty — whether or not/ },
    readme: /Blocking engages on an \*\*empty window, `since` or not\*\*/,
    // The tool routes ANY block_ms > 0 through fetchRecentBlocking, which re-enters with the cursor
    // the first page reported — so a since-less call on an empty topic holds the whole budget.
    forbidden: /returns at once, even on a topic\s+whose room does not exist yet/,
  },
  'the block_ms clamp defaults to 60s': {
    core: { file: 'config.ts', pattern: /block_max_ms: z[\s\S]{0,400}?\.default\(60_000\)/ },
    readme: /`catchup\.block_max_ms` \(default 60s\)/,
  },
  'an omitted since means the recent window': {
    core: { file: 'transport/tools.ts', pattern: /Omit for the recent window/ },
    readme: /`fetchRecent` \(no `since`\)/,
  },
  'an absent topic is an empty page here, never the topicAbsent answer': {
    core: { file: 'transport/tools.ts', pattern: /topicAbsent: true/ },
    readme: /reads as an empty page/,
    // `topicAbsent` is core's rendering of NoSuchTopicError; this plugin never raises it, which is
    // what makes the README's "empty page" true rather than a second name for the same thing.
    pluginMustNotMatch: /NoSuchTopicError/,
  },
};

describe('the README does not contradict the tool semantics core ships', () => {
  it.each(Object.entries(CORE_OWNED_CLAIMS))('%s', (_name, claim) => {
    expect(
      CORE_SOURCES[claim.core.file],
      `core reworded ${claim.core.file}: re-read it and re-state the README claim`,
    ).toMatch(claim.core.pattern);
    expect(README).toMatch(claim.readme);
    if (claim.forbidden !== undefined) expect(README).not.toMatch(claim.forbidden);
    if (claim.pluginMustNotMatch !== undefined) {
      expect(PLUGIN_SRC).not.toMatch(claim.pluginMustNotMatch);
    }
  });
});

/**
 * CLASS (paired with `provisioning.fake.test.ts`'s declared side effects): a permanent, unbounded
 * resource a documented read-only path acquires. The plugin joins a room on every read and never
 * leaves one, and the joined-room set is what bounds `/sync` latency — so the README paragraph that
 * says a read never provisions has to name the join it DOES make, and the day the plugin grows a
 * leave, this fails so the paragraph is rewritten rather than left stale.
 */
describe('the read-path paragraph names the side effect a read does have', () => {
  const readsSection = (): string => {
    const from = README.indexOf('**Reads never provision');
    return README.slice(from, README.indexOf('\n## ', from));
  };

  it('finds the paragraph it is meant to grade', () => {
    expect(readsSection()).toContain('Reads never provision');
  });

  it('names the JOIN, and what the joined-room set costs', () => {
    expect(readsSection()).toMatch(/join/i);
    expect(readsSection()).toMatch(/`\/sync`/);
  });

  it('the plugin still never leaves or forgets a room, as that paragraph says', () => {
    expect(PLUGIN_SRC).not.toMatch(/\/(?:leave|forget)`/);
  });
});
