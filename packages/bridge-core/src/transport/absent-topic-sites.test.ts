import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, describe, expect, it } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { catchUpAll, catchUpTopic } from '../engine/catchup.js';
import type { ReadStateStore } from '../engine/read-state.js';
import { SeenSet } from '../engine/seen-set.js';
import { asHandle, asTopic } from '../message.js';
import * as surface from '../index.js';
import { NoSuchTopicError } from '../no-such-topic.js';
import type { BackendPlugin } from '../seam.js';
import { FetchAbortedError } from '../engine/blocking-fetch.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { memoryReadState } from '../testing/nonconformant.js';
import { toolClient } from '../testing/tool-harness.js';
import { startPushLoop } from './push-loop.js';

/**
 * Every plugin depends on `@sharptrick/parley-core` as an ordinary dependency, so two installs in
 * one tree is a normal outcome — and then the absence sentinel a plugin throws is an instance of the
 * OTHER copy's class. Recognition therefore has to be by contract, at EVERY site: one site left on
 * `instanceof` reads "this chat channel does not exist yet" as a hard backend failure and bricks the
 * whole bridge on startup.
 *
 * Table the sites against the errors they must tell apart, and keep every other module in core out
 * of reach of the class binding a drift back to `instanceof` would need.
 */
const T = asTopic('ctx');

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(HERE, '..', '..');
const REPO_ROOT = join(PKG_DIR, '..', '..');
const DIST = join(PKG_DIR, 'dist');

/**
 * A SECOND INSTALL of this package — this source, built and loaded as its own module graph, so every
 * class it hands back is a genuinely different class object from the one core holds. A hand-written
 * twin cannot stand in: it sets `name` from its own literal, so it agrees with this source by
 * construction and can never disagree when this source drifts.
 *
 * Built here rather than assumed, so that the rows below cannot grade a `dist/` older than the
 * source they are running against; `--force` is only for a deleted `dist/` under a tsbuildinfo that
 * still reports the project up to date.
 */
const TSC = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
execFileSync(TSC, ['-b', 'packages/bridge-core'], { cwd: REPO_ROOT, stdio: 'pipe' });
if (!existsSync(join(DIST, 'index.js'))) {
  execFileSync(TSC, ['-b', 'packages/bridge-core', '--force'], { cwd: REPO_ROOT, stdio: 'pipe' });
}
// Inside the repo's own `node_modules`, so the copy resolves its bare dependencies the way an
// install of it would.
const SECOND_INSTALL = mkdtempSync(join(REPO_ROOT, 'node_modules', 'parley-second-install-'));
cpSync(DIST, join(SECOND_INSTALL, 'dist'), { recursive: true });
cpSync(join(PKG_DIR, 'package.json'), join(SECOND_INSTALL, 'package.json'));
const OTHER = (await import(
  pathToFileURL(join(SECOND_INSTALL, 'dist', 'index.js')).href
)) as Record<string, unknown>;
afterAll(() => rmSync(SECOND_INSTALL, { recursive: true, force: true }));

type ErrorClass = new (arg: string) => Error;

const LOCAL = surface as Record<string, unknown>;

const isErrorClass = (v: unknown): boolean =>
  typeof v === 'function' && Error.isPrototypeOf(v as object);

const errorClassesOf = (mod: Record<string, unknown>): string[] =>
  Object.entries(mod)
    .filter(([, v]) => isErrorClass(v))
    .map(([name]) => name)
    .sort();

/** The sentinels a copy of this package publishes an `is…` recogniser for. */
const recognisedBy = (mod: Record<string, unknown>): string[] =>
  errorClassesOf(mod).filter((name) => typeof mod[`is${name}`] === 'function');

const RECOGNISED = recognisedBy(LOCAL);

/** `sentinel`, constructed from the other install. */
function foreignTwinOf(sentinel: string): Error {
  const cls = OTHER[sentinel];
  if (!isErrorClass(cls)) throw new Error(`the second install publishes no ${sentinel}`);
  return new (cls as ErrorClass)('ctx');
}

const recogniserFor = (sentinel: string): ((err: unknown) => boolean) =>
  LOCAL[`is${sentinel}`] as (err: unknown) => boolean;

describe('a duplicate install of this package really is a second set of classes', () => {
  it('the second install publishes the same recognised sentinels this one does', () => {
    expect(RECOGNISED).not.toEqual([]);
    expect(recognisedBy(OTHER)).toEqual(RECOGNISED);
  });

  it.each(RECOGNISED)('%s from the second install is not an instance of this one', (sentinel) => {
    expect(foreignTwinOf(sentinel) instanceof (LOCAL[sentinel] as ErrorClass)).toBe(false);
  });

  it.each(RECOGNISED)("%s's recogniser accepts the second install's instance", (sentinel) => {
    expect(recogniserFor(sentinel)(foreignTwinOf(sentinel))).toBe(true);
  });
});

type Outcome = 'degraded' | 'propagated';

const ERRORS = {
  'the native sentinel': (): never => {
    throw new NoSuchTopicError('ctx');
  },
  'a foreign twin from a duplicate install': (): never => {
    throw foreignTwinOf('NoSuchTopicError');
  },
  'a generic backend failure': (): never => {
    throw new Error('backend on fire');
  },
} as const;

const EXPECTED: Record<keyof typeof ERRORS, Outcome> = {
  'the native sentinel': 'degraded',
  'a foreign twin from a duplicate install': 'degraded',
  'a generic backend failure': 'propagated',
};

/** A plugin whose named seam method fails; everything else behaves. */
function failingOn(method: 'fetchRecent' | 'subscribe', fail: () => never): BackendPlugin {
  const plugin = new FakePlugin();
  plugin[method] = async (): Promise<never> => fail();
  return plugin;
}

async function settled(work: Promise<unknown>): Promise<Outcome> {
  return work.then(
    () => 'degraded' as Outcome,
    () => 'propagated' as Outcome,
  );
}

async function toolOutcome(tool: string, args: Record<string, unknown>, fail: () => never): Promise<Outcome> {
  const { client } = await toolClient({
    plugin: failingOn('fetchRecent', fail),
    topics: ['ctx'],
  });
  const res = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean };
  return res.isError === true ? 'propagated' : 'degraded';
}

const SITES: Array<[name: string, run: (fail: () => never) => Promise<Outcome>]> = [
  [
    'catchUpTopic',
    (fail) =>
      settled(
        catchUpTopic({
          plugin: failingOn('fetchRecent', fail),
          topic: T,
          limit: 10,
          readState: memoryReadState() as unknown as ReadStateStore,
          seen: new SeenSet(),
        }),
      ),
  ],
  [
    'catchUpTopic resuming from a stored cursor',
    (fail) => {
      const readState = memoryReadState();
      readState.set(T, '7' as never);
      return settled(
        catchUpTopic({
          plugin: failingOn('fetchRecent', fail),
          topic: T,
          limit: 10,
          readState: readState as unknown as ReadStateStore,
          seen: new SeenSet(),
        }),
      );
    },
  ],
  [
    'catchUpAll',
    (fail) =>
      settled(
        catchUpAll({
          plugin: failingOn('fetchRecent', fail),
          topics: [T, asTopic('ops')],
          limit: 10,
          readState: memoryReadState() as unknown as ReadStateStore,
          seen: new SeenSet(),
        }),
      ),
  ],
  [
    'startPushLoop',
    (fail) =>
      settled(
        startPushLoop(
          { server: { notification: async (): Promise<void> => {} } } as unknown as McpServer,
          failingOn('subscribe', fail),
          new Allowlist(['ctx']),
          new SeenSet(),
          { mentionFilter: false, identity: asHandle('alice') },
        ),
      ),
  ],
  ['parley_fetch_recent', (fail) => toolOutcome('parley_fetch_recent', { topic: 'ctx' }, fail)],
  [
    'parley_fetch_recent (long-poll)',
    (fail) => toolOutcome('parley_fetch_recent', { topic: 'ctx', since: '1', block_ms: 200 }, fail),
  ],
];

describe('every absent-topic site recognises the sentinel by contract, not by class identity', () => {
  for (const [site, run] of SITES) {
    it.each(Object.keys(ERRORS) as Array<keyof typeof ERRORS>)(`${site} × %s`, async (kind) => {
      expect(await run(ERRORS[kind])).toBe(EXPECTED[kind]);
    });
  }
});

/**
 * Cancellation is the same problem in a different costume: `FetchAbortedError` crosses from the
 * long-poll wrapper to the tool handler, so a tree with two installs of this package hands the
 * handler a foreign twin — and an `instanceof` check then renders a client hanging up as a backend
 * failure. Table both copies against both call shapes.
 */
describe('a cancelled long-poll is recognised by contract, not by class identity', () => {
  const CANCELLATIONS = {
    'the native cancellation': (): never => {
      throw new FetchAbortedError();
    },
    'a foreign twin from a duplicate install': (): never => {
      throw foreignTwinOf('FetchAbortedError');
    },
  } as const;

  const SHAPES: Array<[name: string, args: Record<string, unknown>]> = [
    ['a plain read', { topic: 'ctx' }],
    ['a long-poll', { topic: 'ctx', block_ms: 200 }],
    ['a long-poll resuming from a cursor', { topic: 'ctx', since: '1', block_ms: 200 }],
  ];

  for (const [shape, args] of SHAPES) {
    it.each(Object.keys(CANCELLATIONS) as Array<keyof typeof CANCELLATIONS>)(
      `${shape} × %s answers with an empty window`,
      async (kind) => {
        expect(await toolOutcome('parley_fetch_recent', args, CANCELLATIONS[kind])).toBe('degraded');
      },
    );
  }
});

describe('no production site in bridge-core recognises a sentinel by class identity', () => {
  const SRC = new URL('..', import.meta.url).pathname;

  function filesUnder(dir: string, ext: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return filesUnder(full, ext);
      return full.endsWith(ext) && !full.includes('.test.') ? [full] : [];
    });
  }

  const relSrc = (f: string): string => f.slice(SRC.length);

  /**
   * Every error class this package declares, as [sentinel, the module that declares it]. DERIVED
   * from the source, so the rule survives that module being renamed or moved, and so a sentinel
   * added later becomes a row rather than a rule nobody applied.
   */
  const SENTINELS = filesUnder(SRC, '.ts').flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/^\s*(?:export )?class (\w+) extends \w*Error\b/gm)].map(
      (m) => [m[1]!, relSrc(f)] as [string, string],
    ),
  );

  const declared = SENTINELS.map(([sentinel]) => sentinel).sort();
  const errorsOnSurface = errorClassesOf(LOCAL);

  /**
   * The walk has gone blind if the barrel exports an error class it did not find — a class
   * EXPRESSION, say, which the pattern above cannot see. Only this direction: an error class the
   * barrel withholds is a private implementation detail, and a rule that reddened for one would be
   * demanding a public API addition as the price of an internal refactor.
   */
  const unwalked = (walked: string[], onSurface: string[]): string[] =>
    onSurface.filter((sentinel) => !walked.includes(sentinel));

  const hasRecogniser = (sentinel: string): boolean => typeof LOCAL[`is${sentinel}`] === 'function';

  /** Exported sentinels with no by-contract recogniser. */
  const unrecognised = (walked: string[], onSurface: string[]): string[] =>
    walked.filter((sentinel) => onSurface.includes(sentinel) && !hasRecogniser(sentinel)).sort();

  /**
   * Sentinels core RAISES and never receives, so no second install of this package can hand core a
   * twin of one to miss: `ConsentError` — the one that IS compared by class, in auth/remote.ts — is
   * compared against the binding the module it is constructed in exports. They still name
   * themselves, graded below, so a consumer holding two installs can tell them apart; what they do
   * not need is a recogniser in core. A sentinel a PLUGIN can raise across the seam never belongs
   * here.
   */
  const RAISED_BY_CORE_ONLY = ['ConsentError', 'TopicNotAllowedError', 'UnsafePatternError'];

  it('the source walk sees every error class this package exports', () => {
    expect(unwalked(declared, errorsOnSurface)).toEqual([]);
  });

  it('every exported sentinel has a recogniser, or is named as one core only raises', () => {
    expect(unrecognised(declared, errorsOnSurface)).toEqual(RAISED_BY_CORE_ONLY);
  });

  it('a private error class needs neither an export nor a recogniser', () => {
    const withPrivate = [...declared, 'PageBudgetExceeded'];
    expect(unwalked(withPrivate, errorsOnSurface)).toEqual([]);
    expect(unrecognised(withPrivate, errorsOnSurface)).toEqual(RAISED_BY_CORE_ONLY);
  });

  it.each(errorsOnSurface)('%s names itself, so any install can recognise it', (sentinel) => {
    expect(new (LOCAL[sentinel] as ErrorClass)('x').name).toBe(sentinel);
  });

  /**
   * `instanceof` needs the class BINDING, and a module reaches one only by importing it — so banning
   * the import bans the comparison whatever the operator (`instanceof`, `.constructor ===`) and
   * whatever the local alias. Read the EMIT rather than the source: an import that survives to
   * runtime is exactly the one that can reach an operator, so the type-only erasure this rule must
   * not fire on is settled by the compiler instead of re-derived from syntax. What recognition must
   * DO is graded by the foreign-twin rows above; this keeps the shortcut out of reach.
   */
  function holdsClassBinding(src: string, sentinel: string): boolean {
    const binds = (clause: string): boolean =>
      clause
        .replace(/[{}]/g, '')
        .split(',')
        .some((spec) => spec.trim().split(/\s+as\s+|\s*:\s*/)[0]!.trim() === sentinel);

    /** Every local name the whole module object is reachable through. */
    const namespaces = [
      ...[...src.matchAll(/import\s*\*\s*as\s+(\w+)\s*from/g)],
      ...[...src.matchAll(/import\s+(\w+)\s*(?:,\s*[{*]|from)/g)],
      ...[...src.matchAll(/(\w+)\s*=\s*(?:await\s+)?(?:import|require)\s*\(/g)],
    ].map((m) => m[1]!);

    for (const m of src.matchAll(/import\s*({[^}]*})\s*from/g)) if (binds(m[1]!)) return true;
    for (const m of src.matchAll(/({[^}]*})\s*=\s*(?:await\s+)?(?:import|require)\s*\(/g)) {
      if (binds(m[1]!)) return true;
    }
    for (const ns of namespaces) {
      if (new RegExp(`\\b${ns}\\s*\\.\\s*${sentinel}\\b`).test(src)) return true;
      for (const m of src.matchAll(new RegExp(`({[^}]*})\\s*=\\s*${ns}\\b`, 'g'))) {
        if (binds(m[1]!)) return true;
      }
    }
    return false;
  }

  /**
   * A detector that silently answers `false` grades nothing, and every rewrite of this rule has
   * grown a new hole rather than closed the last one. Every authoring form that leaves a module
   * holding the binding is a row, so a hole fails a row of this table instead of passing production.
   */
  const HOLDS: Array<[form: string, src: string]> = [
    ['a named import', "import { asTopic, NoSuchTopicError } from './no-such-topic.js';"],
    ['an aliased named import', "import { NoSuchTopicError as Absent } from './no-such-topic.js';"],
    [
      'a namespace member',
      "import * as core from './index.js';\nif (e instanceof core.NoSuchTopicError) {}",
    ],
    [
      'a namespace destructure',
      "import * as core from './index.js';\nconst { NoSuchTopicError } = core;",
    ],
    ['a dynamic import', "const { NoSuchTopicError } = await import('./no-such-topic.js');"],
    ['a dynamic namespace', "const core = await import('./index.js');\ncore.NoSuchTopicError;"],
    ['a require', "const { NoSuchTopicError } = require('./no-such-topic.js');"],
    ['a require namespace', "const core = require('./index.js');\ncore.NoSuchTopicError;"],
    ['a default import member', "import core from './index.js';\ncore.NoSuchTopicError;"],
  ];

  const DOES_NOT_HOLD: Array<[form: string, src: string]> = [
    ['a marker comparison', "if (err.name === 'NoSuchTopicError') return true;"],
    ['a recogniser import', "import { isNoSuchTopicError } from './no-such-topic.js';"],
    ['a longer name that contains it', "import { NoSuchTopicErrorPage } from './pages.js';"],
    ['a type-only specifier', "import { type NoSuchTopicError } from './no-such-topic.js';"],
    ['a barrel re-export', "export { NoSuchTopicError } from './no-such-topic.js';"],
  ];

  it.each(HOLDS)('%s leaves the module holding the binding', (_form, src) => {
    expect(holdsClassBinding(src, 'NoSuchTopicError')).toBe(true);
  });

  it.each(DOES_NOT_HOLD)('%s does not', (_form, src) => {
    expect(holdsClassBinding(src, 'NoSuchTopicError')).toBe(false);
  });

  // A sentinel's `name` is what a SECOND install matches on, so the declaration must pin it to the
  // literal. Read from the EMIT: dropping the annotation compiles clean, keeps `this.constructor.name`
  // correct in an unminified test, and is invisible to both the compiler ratchet and the second-install
  // fixture — but it emits `name: string`, which a consumer's checker can see.
  it.each(SENTINELS)('%s declares its name as a literal in the shipped types', (sentinel, owner) => {
    const dts = readFileSync(join(DIST, owner.replace(/\.ts$/, '.d.ts')), 'utf8');
    const decl = new RegExp(`class ${sentinel}\\b[\\s\\S]*?readonly name: ([^;]+);`).exec(dts);
    expect(decl, `${sentinel} declares no readonly name in ${owner}`).not.toBeNull();
    expect(
      decl?.[1]?.trim(),
      'a sentinel whose emitted name is `string` no longer pins the marker a foreign install matches on',
    ).not.toBe('string');
  });

  const emitted = filesUnder(DIST, '.js');
  const relDist = (f: string): string => f.slice(DIST.length + 1);
  const emitOf = (owner: string): string => owner.replace(/\.ts$/, '.js');

  it('the emit walk reaches the modules the rule below grades', () => {
    expect(emitted.map(relDist)).toEqual(
      expect.arrayContaining(SENTINELS.map(([, owner]) => emitOf(owner))),
    );
  });

  it.each(SENTINELS.filter(([sentinel]) => hasRecogniser(sentinel)))(
    '%s survives to runtime only in %s',
    (sentinel, owner) => {
      const holders = emitted
        .filter(
          (f) =>
            relDist(f) !== emitOf(owner) && holdsClassBinding(readFileSync(f, 'utf8'), sentinel),
        )
        .map(relDist);
      expect(holders).toEqual([]);
    },
  );
});
