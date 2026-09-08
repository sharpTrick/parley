import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, describe, expect, it } from 'vitest';
import { Allowlist, TopicNotAllowedError, UnsafePatternError } from '../allowlist.js';
import { catchUpAll, catchUpTopic } from '../engine/catchup.js';
import type { ReadStateStore } from '../engine/read-state.js';
import { SeenSet } from '../engine/seen-set.js';
import { asHandle, asTopic } from '../message.js';
import * as surface from '../index.js';
import { NoSuchTopicError } from '../no-such-topic.js';
import { BlockingFetchUnsupportedError } from '../blocking-unsupported.js';
import { ConsentError } from '../auth/oauth-provider.js';
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


/**
 * A sentinel's `name` is what a second install matches on. Pinned by the COMPILER rather than read
 * out of an artifact: three source scanners and one over the emitted declarations each grew a new
 * hole rather than closing the last, because each graded the SYNTAX a declaration happens to be
 * written in. `Exactly` grades the property — the type of `name` is the class's own name and
 * nothing wider — so an alias to `string`, a getter, and an un-annotated literal are all answered
 * by `tsc` instead of by a pattern.
 */
type Exactly<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;

/**
 * Imported from the modules that DECLARE them rather than through the barrel, so that the row
 * below asserting each is the class the barrel publishes is a comparison rather than a tautology.
 */
const SENTINEL_CLASSES = {
  BlockingFetchUnsupportedError,
  ConsentError,
  FetchAbortedError,
  NoSuchTopicError,
  TopicNotAllowedError,
  UnsafePatternError,
};

const NAME_PINS: {
  [K in keyof typeof SENTINEL_CLASSES]: Exactly<
    InstanceType<(typeof SENTINEL_CLASSES)[K]>['name'],
    K
  >;
} = {
  BlockingFetchUnsupportedError: true,
  ConsentError: true,
  FetchAbortedError: true,
  NoSuchTopicError: true,
  TopicNotAllowedError: true,
  UnsafePatternError: true,
};

type TokenKind = 'ident' | 'string' | 'number' | 'punct' | 'regex';

interface Token {
  kind: TokenKind;
  /** A string's CONTENTS; every other token's source text. */
  value: string;
}

/** Operators after which a `/` divides rather than opens a regular expression. */
const CLOSERS = new Set([')', ']', '}', '++', '--']);

/** Keywords after which it opens one anyway. */
const OPERATOR_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'throw',
]);

const isIdStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/**
 * JavaScript, as tokens. The one primitive under every rule below, so that what they read is CODE:
 * a sentinel named in a JSDoc block the emit preserves, or in the message of a marker comparison,
 * is a comment and a string here and can no longer be mistaken for a class binding — and equally,
 * a binding reached by a spelling no pattern anticipated is still an identifier.
 */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const regexMayFollow = (): boolean => {
    const p = out[out.length - 1];
    if (p === undefined) return true;
    if (p.kind === 'ident') return OPERATOR_KEYWORDS.has(p.value);
    if (p.kind === 'punct') return !CLOSERS.has(p.value);
    return false;
  };
  const frames: Array<'code' | 'template'> = ['code'];
  const braces: number[] = [0];
  let i = 0;
  while (i < src.length) {
    if (frames[frames.length - 1] === 'template') {
      let text = '';
      while (i < src.length) {
        const c = src[i]!;
        if (c === '\\') {
          text += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (c === '`') {
          i++;
          frames.pop();
          break;
        }
        if (c === '$' && src[i + 1] === '{') {
          i += 2;
          frames.push('code');
          braces.push(0);
          break;
        }
        text += c;
        i++;
      }
      out.push({ kind: 'string', value: text });
      continue;
    }
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      let text = '';
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          text += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        text += src[i];
        i++;
      }
      i++;
      out.push({ kind: 'string', value: text });
      continue;
    }
    if (c === '`') {
      i++;
      frames.push('template');
      continue;
    }
    if (c === '/' && regexMayFollow()) {
      const start = i;
      i++;
      let inClass = false;
      while (i < src.length) {
        const d = src[i]!;
        if (d === '\\') {
          i += 2;
          continue;
        }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        i++;
      }
      i++;
      while (i < src.length && isIdStart(src[i]!)) i++;
      out.push({ kind: 'regex', value: src.slice(start, i) });
      continue;
    }
    if (isIdStart(c)) {
      const start = i;
      while (i < src.length && (isIdStart(src[i]!) || isDigit(src[i]!))) i++;
      out.push({ kind: 'ident', value: src.slice(start, i) });
      continue;
    }
    if (isDigit(c)) {
      const start = i;
      while (i < src.length && (isDigit(src[i]!) || isIdStart(src[i]!) || src[i] === '.')) i++;
      out.push({ kind: 'number', value: src.slice(start, i) });
      continue;
    }
    if (c === '{') {
      braces[braces.length - 1]!++;
      out.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '}') {
      if (braces[braces.length - 1] === 0 && frames.length > 1) {
        frames.pop();
        braces.pop();
        i++;
        continue;
      }
      braces[braces.length - 1]!--;
      out.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '++' || two === '--') {
      out.push({ kind: 'punct', value: two });
      i += 2;
      continue;
    }
    out.push({ kind: 'punct', value: c });
    i++;
  }
  return out;
}

/** The index of the `)` closing the `(` at `open`, or -1. */
function closingParen(toks: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind !== 'punct') continue;
    if (t.value === '(') depth++;
    else if (t.value === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Every call to `name` in `toks`, as the token span of the whole call expression — trailing
 * argument lists included, so that `it.each(TABLE)(title, body)` is ONE span covering the case
 * body. A `function name(` declaration is not a call and gets no span, so a rule below cannot be
 * satisfied by a helper simply being declared.
 */
function callSpans(toks: Token[], name: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind !== 'ident' || t.value !== name) continue;
    if (toks[i - 1]?.kind === 'ident' && toks[i - 1]!.value === 'function') continue;
    let j = i + 1;
    while (toks[j]?.kind === 'punct' && toks[j]!.value === '.') j += 2;
    if (toks[j]?.value !== '(') continue;
    let end = j;
    while (toks[end]?.kind === 'punct' && toks[end]!.value === '(') {
      const close = closingParen(toks, end);
      if (close === -1) break;
      end = close + 1;
    }
    spans.push([i, end - 1]);
  }
  return spans;
}

const within = (spans: Array<[number, number]>, at: number): boolean =>
  spans.some(([from, to]) => at >= from && at <= to);

/**
 * A detector that answers `false` for the wrong reason grades nothing, and every rewrite of these
 * rules has grown a new hole rather than closed the last one. Registering a detector is the only
 * way to get one, and it costs a POSITIVE and a NEGATIVE control table — neither of which the type
 * lets you leave empty — so a hole fails a row of the detector's own table instead of passing
 * production. The row that re-opened F3 twice over had no table at all.
 */
type ControlRow<A extends unknown[]> = [form: string, ...args: A];
type ControlTable<A extends unknown[]> = [ControlRow<A>, ...Array<ControlRow<A>>];

const CONTROLLED: string[] = [];

const detected = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : Boolean(v));

function controlled<A extends unknown[], R>(
  what: string,
  detect: (...args: A) => R,
  finds: ControlTable<A>,
  misses: ControlTable<A>,
): (...args: A) => R {
  CONTROLLED.push(what);
  it.each(finds)(`${what}: %s is found`, (_form, ...args) => {
    expect(detected(detect(...(args as A)))).toBe(true);
  });
  it.each(misses)(`${what}: %s is not`, (_form, ...args) => {
    expect(detected(detect(...(args as A)))).toBe(false);
  });
  return detect;
}

describe('no production site in bridge-core recognises a sentinel by class identity', () => {
  const SRC = new URL('..', import.meta.url).pathname;
  const S = 'NoSuchTopicError';

  function filesUnder(dir: string, ext: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return filesUnder(full, ext);
      return full.endsWith(ext) && !full.includes('.test.') ? [full] : [];
    });
  }

  const relSrc = (f: string): string => f.slice(SRC.length);
  const emitOf = (owner: string): string => `${owner.slice(0, -'.ts'.length)}.js`;

  /**
   * Every error class this package declares, as [sentinel, the module that declares it]. DERIVED
   * from the source, so the rule survives that module being renamed or moved, and so a sentinel
   * added later becomes a row rather than a rule nobody applied.
   */
  const declarationsIn = controlled(
    'the error-class walk',
    (src: string): string[] =>
      [...src.matchAll(/^\s*(?:export )?class (\w+) extends \w*Error\b/gm)].map((m) => m[1]!),
    [
      ['an exported error class', 'export class NoSuchTopicError extends Error {'],
      ['a class this package does not export', 'class PageBudgetExceeded extends Error {'],
      ['a class extending another Error type', 'export class Late extends TypeError {'],
      ['a declaration the file indents', '  export class Nested extends Error {'],
    ],
    [
      ['a class that is not an error', 'export class Allowlist extends Base {'],
      ['an interface', 'export interface Wrapped extends Error {}'],
      ['a line comment naming one', '// class Ghost extends Error is not a declaration'],
      ['a JSDoc line naming one', ' * class Ghost extends Error, described'],
    ],
  );

  const SENTINELS = filesUnder(SRC, '.ts').flatMap((f) =>
    declarationsIn(readFileSync(f, 'utf8')).map((name) => [name, relSrc(f)] as [string, string]),
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
   * themselves, pinned below, so a consumer holding two installs can tell them apart; what they do
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

  it('the compiler pins the name of every error class the barrel publishes', () => {
    expect(Object.keys(NAME_PINS).sort()).toEqual(errorsOnSurface);
  });

  it.each(Object.entries(SENTINEL_CLASSES))(
    'the class %s is pinned under is the one the barrel publishes',
    (sentinel, cls) => {
      expect(cls).toBe(LOCAL[sentinel]);
    },
  );

  /**
   * `instanceof` needs the class BINDING, and a module reaches one only by importing it — so
   * banning the import bans the comparison whatever the operator (`instanceof`,
   * `.constructor ===`) and whatever the local alias. Read the EMIT rather than the source: an
   * import that survives to runtime is exactly the one that can reach an operator, so the
   * type-only erasure this rule must not fire on is settled by the compiler instead of re-derived
   * from syntax. What recognition must DO is graded by the foreign-twin rows above; this keeps the
   * shortcut out of reach.
   *
   * Deny by IDENTIFIER rather than by enumerated import forms: the class object is reachable
   * wherever its own name is a token of the module's code, and the six spellings the enumeration
   * missed — a computed member, an inline dynamic import, a two-hop alias, a default import, a
   * `createRequire`, a comment between the braces — are all just that. A re-export names it
   * without binding it, and a string names it without reaching it unless the string IS the member
   * being read.
   */
  const holdsClassBinding = controlled(
    'a module holding the class binding',
    (src: string, sentinel: string): boolean => {
      const toks = tokenize(src);
      const reExported = (at: number): boolean => {
        let open = -1;
        for (let i = at - 1; i >= 0; i--) {
          const t = toks[i]!;
          if (t.kind !== 'punct') continue;
          if (t.value === '}') return false;
          if (t.value === '{') {
            open = i;
            break;
          }
        }
        if (open <= 0) return false;
        const before = toks[open - 1]!;
        if (before.kind !== 'ident' || before.value !== 'export') return false;
        let close = -1;
        for (let i = at + 1; i < toks.length; i++) {
          const t = toks[i]!;
          if (t.kind === 'punct' && t.value === '}') {
            close = i;
            break;
          }
        }
        const after = close === -1 ? undefined : toks[close + 1];
        return after?.kind === 'ident' && after.value === 'from';
      };
      return toks.some((t, at) => {
        if (t.kind === 'ident') return t.value === sentinel && !reExported(at);
        return t.kind === 'string' && t.value === sentinel && toks[at - 1]?.value === '[';
      });
    },
    [
      ['a named import', "import { asTopic, NoSuchTopicError } from './no-such-topic.js';", S],
      ['an aliased named import', "import { NoSuchTopicError as Absent } from './x.js';", S],
      [
        'a namespace member',
        "import * as core from './index.js';\nif (e instanceof core.NoSuchTopicError) {}",
        S,
      ],
      [
        'a computed namespace member',
        "import * as core from './index.js';\nif (e instanceof core['NoSuchTopicError']) {}",
        S,
      ],
      [
        'a namespace destructure',
        "import * as core from './index.js';\nconst { NoSuchTopicError } = core;",
        S,
      ],
      [
        'a two-hop namespace alias',
        "import * as core from './index.js';\nconst c = core;\nc.NoSuchTopicError;",
        S,
      ],
      ['a dynamic import', "const { NoSuchTopicError } = await import('./x.js');", S],
      ['a dynamic namespace', "const core = await import('./index.js');\ncore.NoSuchTopicError;", S],
      ['an inline dynamic import member', "(await import('./index.js')).NoSuchTopicError;", S],
      ['a require', "const { NoSuchTopicError } = require('./x.js');", S],
      ['a require namespace', "const core = require('./index.js');\ncore.NoSuchTopicError;", S],
      [
        'a createRequire',
        "const req = createRequire(import.meta.url);\nconst { NoSuchTopicError } = req('./x.js');",
        S,
      ],
      ['a default import member', "import core from './index.js';\ncore.NoSuchTopicError;", S],
      ['a default import named as the sentinel', "import NoSuchTopicError from './index.js';", S],
      [
        'a named import with a comment between the braces',
        "import { /* the sentinel */ NoSuchTopicError } from './x.js';",
        S,
      ],
      [
        'a member read out of a template interpolation',
        'import * as core from "./index.js";\nconst s = `${core.NoSuchTopicError}`;',
        S,
      ],
    ],
    [
      ['a marker comparison', "if (err.name === 'NoSuchTopicError') return true;", S],
      ['a recogniser import', "import { isNoSuchTopicError } from './no-such-topic.js';", S],
      ['a longer name that contains it', "import { NoSuchTopicErrorPage } from './pages.js';", S],
      ['a barrel re-export', "export { NoSuchTopicError } from './no-such-topic.js';", S],
      [
        'a re-export beside other names',
        "export { asTopic, NoSuchTopicError, isNoSuchTopicError } from './x.js';",
        S,
      ],
      ['a line comment naming it', '// NoSuchTopicError is recognised by contract, not by class', S],
      ['a JSDoc block naming it', '/** {@link NoSuchTopicError} and why. */\nexport const x = 1;', S],
      ['a diagnostic naming it', "throw new Error('expected a NoSuchTopicError here');", S],
    ],
  );

  /**
   * Which modules CALL a by-contract recogniser — the derived form of the site table above. A
   * recogniser call is what makes a module a site, so a site added later arrives here as a red row
   * rather than as a behaviour nothing tables.
   */
  const recogniserCallsIn = controlled(
    'a module calling a recogniser',
    (src: string, sentinels: string[]): string[] => {
      const toks = tokenize(src);
      const names = new Set(sentinels.map((s) => `is${s}`));
      return toks
        .filter(
          (t, i) =>
            t.kind === 'ident' &&
            names.has(t.value) &&
            toks[i + 1]?.value === '(' &&
            !(toks[i - 1]?.kind === 'ident' && toks[i - 1]!.value === 'function'),
        )
        .map((t) => t.value);
    },
    [
      ['a call', 'if (!isNoSuchTopicError(err)) throw err;', [S]],
      ['a call through a namespace', 'if (core.isNoSuchTopicError(err)) return [];', [S]],
    ],
    [
      ['the recogniser it declares', 'export function isNoSuchTopicError(err) { return false; }', [S]],
      ['a re-export of one', "export { isNoSuchTopicError } from './no-such-topic.js';", [S]],
      ['a mention in a comment', '// recognised via isNoSuchTopicError(err), by contract', [S]],
    ],
  );

  const DIST_FILES = filesUnder(DIST, '.js');
  const relDist = (f: string): string => f.slice(DIST.length + 1);
  const shipped = filesUnder(SRC, '.ts')
    .filter((f) => !f.endsWith('.d.ts'))
    .map((f) => emitOf(relSrc(f)));
  // `tsc -b` never deletes the output of a source that was removed, so a dist carrying a module
  // from an earlier chunk would be read here as a live recogniser. Grade only what a source still
  // backs, so a stale local build reports the real rule rather than a phantom module.
  const emitted = DIST_FILES.map((f) => [relDist(f), readFileSync(f, 'utf8')] as [string, string])
    .filter(([name]) => shipped.includes(name));

  const holdersOf = (sentinel: string, owner: string): string[] =>
    emitted
      .filter(([name, text]) => name !== emitOf(owner) && holdsClassBinding(text, sentinel))
      .map(([name]) => name);

  const recogniserSites = (): string[] =>
    emitted
      .filter(([, text]) => recogniserCallsIn(text, RECOGNISED).length > 0)
      .map(([name]) => name)
      .sort();

  /**
   * Every module that asks whether a rejection is a sentinel, against the behavioural site it is
   * reached through above. A module added to this set with no row up there is a site whose
   * recognition nothing grades — which is the whole failure this file exists to prevent, arriving
   * by addition rather than by drift.
   */
  const RECOGNISER_SITES: Record<string, string> = {
    'engine/catchup.js': 'catchUpTopic',
    'transport/push-loop.js': 'startPushLoop',
    'transport/tools.js': 'parley_fetch_recent',
  };

  it('the emit walk reaches every module this package ships', () => {
    expect(emitted.map(([name]) => name)).toEqual(expect.arrayContaining(shipped));
    expect(shipped).toEqual(expect.arrayContaining(SENTINELS.map(([, owner]) => emitOf(owner))));
  });

  it('every module that recognises a sentinel is a site the rows above drive', () => {
    expect(recogniserSites()).toEqual(Object.keys(RECOGNISER_SITES).sort());
    const siteNames = SITES.map(([name]) => name);
    expect(
      Object.values(RECOGNISER_SITES).filter(
        (site) => !siteNames.some((name) => name.startsWith(site)),
      ),
      'a module calls a recogniser but the behavioural table above reaches it through no site',
    ).toEqual([]);
  });

  it.each(SENTINELS.filter(([sentinel]) => hasRecogniser(sentinel)))(
    '%s survives to runtime only in %s',
    (sentinel, owner) => {
      expect(holdersOf(sentinel, owner)).toEqual([]);
    },
  );
});

/**
 * The rules above read TEXT, and the only reason any of them still discriminates is that its
 * detector ships both control tables. The row that re-opened F3 shipped with none: it was a
 * regular expression written inline in the grading row itself, where nothing required a control
 * and nothing could see it had stopped matching the class it named. So text detection is confined
 * to registered detectors, and a grading row may not do any of its own.
 */
describe('this file grades no text except through a controlled detector', () => {
  const OWN_SOURCE = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const OWN_TOKENS = tokenize(OWN_SOURCE);
  const CONTROLLED_SPANS = callSpans(OWN_TOKENS, 'controlled');
  const CASE_SPANS = [...callSpans(OWN_TOKENS, 'it'), ...callSpans(OWN_TOKENS, 'test')];
  /** Reading a file, or building a pattern, is detection — and belongs in a detector. */
  const DETECTION = ['RegExp', 'readFileSync', 'readdirSync', 'statSync', 'execFileSync', 'cpSync'];

  it('finds the detectors, the cases and the patterns, so the rows below are not empty', () => {
    expect(CONTROLLED, 'no detector was registered').not.toEqual([]);
    expect(CONTROLLED_SPANS.length).toBe(CONTROLLED.length);
    expect(CASE_SPANS.length).toBeGreaterThan(10);
    expect(OWN_TOKENS.filter((t) => t.kind === 'regex').length).toBeGreaterThan(0);
    expect(
      OWN_TOKENS.filter((t) => t.kind === 'ident' && DETECTION.includes(t.value)).length,
    ).toBeGreaterThan(0);
  });

  it('every pattern it writes lives inside a controlled detector', () => {
    const loose = OWN_TOKENS.map((t, at) => [t, at] as const)
      .filter(([t, at]) => t.kind === 'regex' && !within(CONTROLLED_SPANS, at))
      .map(([t]) => t.value);
    expect(
      loose,
      'a pattern outside a controlled detector grades text with no positive and negative ' +
        'control tables — the shape every rewrite of these rules has shipped its next hole in',
    ).toEqual([]);
  });

  it('no case does its own detecting', () => {
    const inline = OWN_TOKENS.map((t, at) => [t, at] as const)
      .filter(
        ([t, at]) =>
          within(CASE_SPANS, at) &&
          !within(CONTROLLED_SPANS, at) &&
          (t.kind === 'regex' || (t.kind === 'ident' && DETECTION.includes(t.value))),
      )
      .map(([t]) => t.value);
    expect(
      inline,
      'a case that reads a file or builds a pattern of its own is a detector nobody controls, ' +
        'sitting where a control table cannot reach it',
    ).toEqual([]);
  });
});
