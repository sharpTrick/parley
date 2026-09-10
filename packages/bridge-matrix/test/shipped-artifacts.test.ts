import { Allowlist, loadConfig } from '@sharptrick/parley-core';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROOM_PRESETS, type MatrixBackendConfig } from '../src/index.js';

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
  /** `post_topics` — post/fetch reach WITHOUT subscription, and rooms are created on post. */
  postPatterns: string[];
  backend: MatrixBackendConfig;
}

// Loaded through core's own `loadConfig`, so a config that would not even parse in production — or
// that fails the schema — fails here rather than being read past by a bespoke parser.
const configs: ShippedConfig[] = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith('.yaml'))
  .map((file) => {
    const doc = loadConfig(fileURLToPath(new URL(file, EXAMPLES)));
    return {
      file,
      topics: doc.topics.map(String),
      postPatterns: doc.post_topics.map(String),
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
   * Which rooms a config can end up in. Reach, not subscription: a room is provisioned by whoever
   * POSTS to its topic first, and `post_topics` grants post reach to topics a config never lists —
   * so a config can be first to create an invite-only room for a topic that appears nowhere in its
   * `topics`, with an `invite` list that names none of the peers who do subscribe to it. Matched
   * through core's own {@link Allowlist}, so full-match semantics are not re-derived here.
   */
  const reachOf = (c: ShippedConfig, universe: string[]): string[] => {
    const allow = new Allowlist(c.topics, { postPatterns: c.postPatterns });
    return universe.filter((t) => allow.has(t));
  };

  /**
   * Any of them may be the first to post to a shared room, and the creator's `invite` is the only
   * thing that admits the rest — so the requirement is symmetric, not "somebody invites everybody".
   *
   * The universe is what the configs ENUMERATE, and `post_topics` reaches past it: two configs each
   * carrying `post_topics: ["ctx-.*"]` can both create `ctx-adhoc`, which no `topics` list names, so
   * neither appears in the other's reach and the pair grades clean. Whether two patterns admit a
   * common topic is regex intersection, which is not decidable in general — so the rule is the
   * conservative one: a config with a non-empty `post_topics` can create a room for a topic nobody
   * enumerates, and must therefore invite every other config in the set.
   */
  function coHabitants(
    set: ShippedConfig[],
  ): [label: string, creator: ShippedConfig, peer: ShippedConfig][] {
    const universe = [...new Set(set.flatMap((c) => c.topics))];
    const reach = new Map(set.map((c) => [c, reachOf(c, universe)] as const));
    return set.flatMap((creator) =>
      set
        .filter((peer) => peer !== creator)
        .flatMap((peer): [string, ShippedConfig, ShippedConfig][] => {
          const shared = reach.get(creator)!.filter((t) => reach.get(peer)!.includes(t));
          if (shared.length > 0)
            return [[`${creator.file} shares ${shared.join(', ')} with ${peer.file}`, creator, peer]];
          if (creator.postPatterns.length > 0)
            return [
              [
                `${creator.file} can create a room for a topic no config enumerates, so it shares one with ${peer.file}`,
                creator,
                peer,
              ],
            ];
          return [];
        }),
    );
  }

  /** Co-habiting pairs whose creator would lock the peer out of the room it creates. */
  const lockouts = (set: ShippedConfig[]): string[] =>
    coHabitants(set)
      .filter(([, creator, peer]) => !(creator.backend.invite ?? []).includes(mxidOf(peer)))
      .map(([label]) => label);

  const coHabiting = coHabitants(configs);

  it('every shipped config shares a room with another (guards against grading less)', () => {
    const stranded = configs
      .filter((c) => !coHabiting.some(([, creator, peer]) => creator === c || peer === c))
      .map((c) => c.file);
    expect(stranded, 'these shipped configs share no topic, so they grade no invite rule').toEqual(
      [],
    );
  });

  it.each(coHabiting)('%s, so it invites it', (_name, creator, peer) => {
    expect(creator.backend.invite ?? []).toContain(mxidOf(peer));
  });

  /**
   * The shipped set cannot carry this hazard without shipping it, so plant it: a third config that
   * reaches a shared topic ONLY through `post_topics` — the escape hatch remote-chat.yaml documents
   * — and invites nobody. A rule that reads `topics` alone calls this deployment safe right up to
   * the moment that config posts first.
   */
  it('flags a config whose only reach into a shared room is post_topics', () => {
    const fixture = (
      file: string,
      topics: string[],
      postPatterns: string[],
      invite: string[],
    ): ShippedConfig => ({
      file,
      topics,
      postPatterns,
      backend: { user: file.replace('.yaml', ''), server_name: 'parley.local', invite } as MatrixBackendConfig,
    });
    const planted = [
      fixture('a.yaml', ['ctx-payments'], [], ['@b:parley.local', '@c:parley.local']),
      fixture('b.yaml', ['ctx-payments'], [], ['@a:parley.local', '@c:parley.local']),
      fixture('c.yaml', ['ctx-private'], ['ctx-.*'], []),
    ];

    expect(
      lockouts(planted),
      'a config reaching a shared room only through post_topics went unflagged',
    ).toEqual(['c.yaml shares ctx-payments with a.yaml', 'c.yaml shares ctx-payments with b.yaml']);

    // The same three with that one reach withdrawn are clean, so the verdict above is the
    // post_topics pattern being read and not a fixture nothing could satisfy.
    const withdrawn = [...planted.slice(0, 2), { ...planted[2]!, postPatterns: [] }];
    expect(lockouts(withdrawn)).toEqual([]);
  });

  /**
   * The hazard one step out from the fixture above: a topic reachable only through `post_topics`
   * and enumerated by nobody. Both configs can create `ctx-adhoc`, neither lists it, so no
   * enumerated universe contains it and a reach-only rule calls the pair safe.
   */
  it('flags two configs whose post_topics both reach a topic no config enumerates', () => {
    const fixture = (
      file: string,
      topics: string[],
      postPatterns: string[],
      invite: string[],
    ): ShippedConfig => ({
      file,
      topics,
      postPatterns,
      backend: { user: file.replace('.yaml', ''), server_name: 'parley.local', invite } as MatrixBackendConfig,
    });
    const planted = [
      fixture('code-agent-a.yaml', ['ctx-a'], ['ctx-adhoc'], []),
      fixture('code-agent-b.yaml', ['ctx-b'], ['ctx-adhoc'], []),
    ];

    expect(
      lockouts(planted),
      'two configs that can both create a room for an unenumerated topic went unflagged',
    ).toEqual([
      'code-agent-a.yaml can create a room for a topic no config enumerates, so it shares one with code-agent-b.yaml',
      'code-agent-b.yaml can create a room for a topic no config enumerates, so it shares one with code-agent-a.yaml',
    ]);

    // Inviting each other clears it, so the verdict above is the invite rule and not a fixture
    // nothing could satisfy.
    const invited = [
      { ...planted[0]!, backend: { ...planted[0]!.backend, invite: ['@code-agent-b:parley.local'] } },
      { ...planted[1]!, backend: { ...planted[1]!.backend, invite: ['@code-agent-a:parley.local'] } },
    ];
    expect(lockouts(invited)).toEqual([]);
  });

  it('no shipped config would lock a peer out of a room it creates', () => {
    expect(lockouts(configs)).toEqual([]);
  });
});

describe('every room_preset the config accepts is in the README config table', () => {
  const table = README.split('\n').filter((l) => l.startsWith('|'));

  it.each(ROOM_PRESETS)('%s', (preset) => {
    expect(table.join('\n')).toContain(`\`${preset}\``);
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
 * EVERY source file this package ships, concatenated — never one named file. A claim about what the
 * plugin never does is a claim about the plugin, and a scan pinned to `src/index.ts` keeps passing
 * the day the code it was written about moves into a sibling module: the assertion stays green while
 * grading a file that no longer holds the thing it forbids.
 */
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const SRC_FILES = readdirSync(SRC_DIR, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.ts'));
const PLUGIN_SRC = SRC_FILES.map((f) => readFileSync(join(SRC_DIR, f), 'utf8')).join('\n');

describe('the plugin-source scans below grade the whole package', () => {
  it('finds every module the package ships, not just its entrypoint', () => {
    expect(SRC_FILES).toContain('index.ts');
    expect(SRC_FILES.length).toBeGreaterThan(1);
    expect(PLUGIN_SRC).toContain('class MatrixPlugin');
  });
});

/**
 * CLASS (paired with `provisioning.fake.test.ts`'s declared side effects): a permanent, unbounded
 * resource a documented read-only path acquires. The plugin joins a room on every read and never
 * leaves one, and the joined-room set is what bounds `/sync` latency — so the README paragraph that
 * says a read never provisions has to name the join it DOES make, and the day the plugin grows a
 * leave, this fails so the paragraph is rewritten rather than left stale.
 *
 * The room mutation is recognised from the path SEGMENT, never from the punctuation around it: a
 * scan keyed on the character that follows — a closing backtick, say — grades one way of writing the
 * same request and walks past a concatenation, a path in a variable, a query string, or a helper in
 * a module nobody thought to look in. Comments are stripped first, so the prose that promises this
 * lever does not exist is not itself read as the lever.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Permanent room mutations reachable from a model-named topic; none belongs on any seam path. */
const FORBIDDEN_ROOM_MUTATIONS = ['leave', 'forget', 'kick', 'ban', 'upgrade'];

const roomMutationsIn = (source: string): string[] =>
  FORBIDDEN_ROOM_MUTATIONS.filter((segment) =>
    new RegExp(`['"\`][^'"\`]*\\/${segment}(?![A-Za-z0-9_])`).test(stripComments(source)),
  );

describe('a read never leaves or forgets a room', () => {
  it('recognizes a room mutation however it is spelled, and prose about one as prose', () => {
    const planted: Record<string, string> = {
      'a template literal': 'this.http("POST", `/_matrix/client/v3/rooms/${id}/leave`, {});',
      'string concatenation':
        "const p = '/_matrix/client/v3/rooms/' + id + '/leave'; this.http('POST', p, {});",
      'a query string after the segment':
        'this.http("POST", `/_matrix/client/v3/rooms/${id}/forget?reason=x`, {});',
      'a helper that only builds the path':
        'export const path = (id: string) => `/rooms/${id}/kick`;',
      'a mutation nobody named in the README': 'const u = `/rooms/${id}/upgrade`;',
    };
    for (const [how, snippet] of Object.entries(planted)) {
      expect(roomMutationsIn(snippet), `a leave written as ${how} was not seen`).not.toEqual([]);
    }

    const innocent: Record<string, string> = {
      'a doc comment naming the lever the plugin lacks':
        '/** There is no `/leave` or `/forget` lever in this plugin. */',
      'a line comment about leaving a room': '// never leaves: no `/leave` is ever issued',
      'an endpoint that merely starts with the word':
        'this.http("GET", `/_matrix/client/v3/rooms/${id}/leaves`, {});',
      'the join a read DOES make': 'this.http("POST", `/_matrix/client/v3/rooms/${id}/join`, {});',
    };
    for (const [how, snippet] of Object.entries(innocent)) {
      expect(roomMutationsIn(snippet), `${how} was read as a room mutation`).toEqual([]);
    }
  });

  it('the plugin still never leaves or forgets a room, as that paragraph says', () => {
    expect(roomMutationsIn(PLUGIN_SRC)).toEqual([]);
  });
});
