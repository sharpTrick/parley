// Barrel-surface regression guard.
//
// The public entry `@sharptrick/parley-core` is automated-semver surface: every symbol it
// re-exports is frozen by the release automation. This test pins the trimmed set (consumer-free
// internals that must NOT be public) and the kept seam/config/composition-root surface, so a
// future edit that re-adds an internal to the barrel fails loudly here.
//
// It is a test only — it does not re-export anything from the barrel.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from './index.js';

const SRC = readdirSync(fileURLToPath(new URL('.', import.meta.url)), { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8'));

describe('public barrel surface', () => {
  // The consumer-free internals kept out of the barrel. These stay defined in their own
  // modules (engine/presence.ts, identity-filter.ts, transport/tools.ts) for in-package callers,
  // reached via relative imports — but must never be reachable through the public entry.
  const trimmed = [
    'matchGlob',
    'filterHandles',
    'MAX_RECORD_TOPICS',
    'MAX_INSTANCE_ID_LEN',
    'encodePresence',
    'decodePresence',
    'computeRoster',
  ] as const;

  // A representative slice of the deliberate kept surface (seam, config, engine, presence
  // default/types, composition roots).
  const kept = [
    'registerTools',
    'DEFAULT_PRESENCE_TOPIC',
    'asTopic',
    'asHandle',
    'asBackendMsgId',
    'asCursor',
    'safeName',
    'MIN_HASH_LEN',
    'DEFAULT_HASH_LEN',
    'MAX_HASH_LEN',
    'MAX_BLOCK_MS',
    'NoSuchTopicError',
    'isNoSuchTopicError',
    'parseMentions',
    'buildMessage',
    'createStdioBridge',
    'buildBridge',
    'loadConfig',
    'parseConfig',
    'Allowlist',
    'SeenSet',
    'catchUpTopic',
    'catchUpAll',
  ] as const;

  it.each(trimmed)('still defines the trimmed internal %s somewhere in src', (name) => {
    expect(
      SRC.some((text) => new RegExp(`\\b(?:function|const|class|interface|type)\\s+${name}\\b`).test(text)),
      `${name} is asserted absent from the barrel but no longer exists in src — a row that grades ` +
        'nothing while reading as coverage. Delete it, or fix the name it drifted from.',
    ).toBe(true);
  });

  it.each(trimmed)('does not re-export the trimmed internal %s', (name) => {
    expect(name in api).toBe(false);
    expect((api as Record<string, unknown>)[name]).toBeUndefined();
  });

  it.each(kept)('still re-exports the kept symbol %s', (name) => {
    expect(name in api).toBe(true);
    expect((api as Record<string, unknown>)[name]).toBeDefined();
  });
});

// A doc comment on a barrel-exported symbol ships verbatim in `dist/*.d.ts` and is the only
// specification an out-of-tree plugin author reads. When it says "outside {@link MIN_HASH_LEN}…{@link
// MAX_HASH_LEN}" and only the floor is exported, that author can name the floor and must hardcode
// the ceiling — the doc promises a surface the package does not have. Pinning the one symbol by name
// would guard the instance; derive the offenders instead, so the next helper documented against an
// unexported constant is caught by the same case.
describe('shipped JSDoc never links a value the barrel withholds', () => {
  const SRC = fileURLToPath(new URL('./', import.meta.url));

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sources(full, out);
      else if (extname(full) === '.ts' && !full.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  const EXPORT_DECL =
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|function|async function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
  const VALUE_DECL = /^export\s+(?:const|function|async function|class)\s+([A-Za-z_$][\w$]*)/;

  // Type-only re-exports are part of the shipped surface but carry no runtime binding, so read the
  // barrel's own export clauses rather than only `Object.keys(api)`.
  const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8');
  const exposed = new Set<string>(Object.keys(api));
  for (const clause of barrel.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const spec of clause[1]!.split(',')) {
      const name = spec.replace(/^\s*type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name) exposed.add(name);
    }

  const files = sources(SRC);
  const values = new Set<string>();
  const documented: { file: string; owner: string; doc: string }[] = [];

  for (const file of files) {
    let block: string[] | null = null;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (line.startsWith('/**')) block = [line];
      else if (block && (line.startsWith('*') || line.startsWith('*/'))) block.push(line);
      else {
        const owner = EXPORT_DECL.exec(line)?.[1];
        if (owner) {
          if (VALUE_DECL.test(line)) values.add(owner);
          if (block) documented.push({ file: file.slice(SRC.length), owner, doc: block.join('\n') });
        }
        block = null;
      }
    }
  }

  it('finds documented exports and exported values to check (guards against a broken walk)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(documented.length).toBeGreaterThan(20);
    expect(values.size).toBeGreaterThan(20);
    expect(values.has('safeName')).toBe(true);
  });

  it('resolves every {@link} in a public doc comment to a public symbol', () => {
    const offenders: string[] = [];
    for (const { file, owner, doc } of documented) {
      if (!exposed.has(owner)) continue;
      for (const link of doc.matchAll(/\{@link\s+([A-Za-z_$][\w$]*)/g))
        if (values.has(link[1]!) && !exposed.has(link[1]!))
          offenders.push(`${file}: ${owner}'s doc links ${link[1]}, which index.ts does not export`);
    }
    expect(
      offenders,
      'export the linked symbol, or state it in prose — a consumer cannot follow a link to a symbol they cannot import',
    ).toEqual([]);
  });

  /**
   * The same closure one step further out: a shipped type whose only sanctioned constructor is
   * withheld. An out-of-tree composition root handed `registerTools` and `ToolDeps` but not
   * `toolDepsFor` has to hand-assemble the dependency bag, so the next required field breaks every
   * external root at compile time — precisely the lockstep edit the factory exists to prevent, and
   * core's own roots are immune to it. Derive the pairs rather than naming them: a function whose
   * declared return type IS an exported type is that type's constructor, and it ships or the type
   * does not.
   */
  // Both shapes the package writes a function in: a declaration, and a `const` arrow (which is how
  // every brand constructor is written) — a scanner that saw only one would call a type orphaned
  // because it could not see the builder that ships.
  const FN_STARTS = [
    /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g,
    /(?:^|\n)(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:<[^<>()]*>)?\(/g,
  ];

  interface Declared {
    name: string;
    params: string;
    returns: string;
  }

  /** Every declared function's name, its parameter text, and its declared return type. */
  function declaredFunctions(src: string): Declared[] {
    const out: Declared[] = [];
    for (const start of FN_STARTS) {
      for (const m of src.matchAll(start)) {
        const open = m.index + m[0].length - 1;
        let depth = 0;
        let i = open;
        do {
          if (src[i] === '(') depth++;
          else if (src[i] === ')') depth--;
          i++;
        } while (depth > 0 && i < src.length);
        const tail = /^\s*:\s*([^{;=]+?)\s*(?:\{|=>)/.exec(src.slice(i));
        if (tail) {
          out.push({
            name: m[1]!,
            params: src.slice(open + 1, i - 1),
            returns: tail[1]!.trim(),
          });
        }
      }
    }
    return out;
  }

  const functions = files.flatMap((f) =>
    declaredFunctions(readFileSync(f, 'utf8')).map((fn) => ({ ...fn, file: f.slice(SRC.length) })),
  );

  it.each([
    ['a plain declaration', 'export function f(a: number): Thing {', 'Thing'],
    ['a multi-line signature', 'export function f(\n  a: number,\n  b: string,\n): Thing {', 'Thing'],
    ['a parameter that is itself a function', 'function f(p: (t: string) => boolean): Thing {', 'Thing'],
    ['a generic signature', 'function f<T>(p: T): Thing {', 'Thing'],
    ['a const arrow', 'export const f = (s: string): Thing => s as Thing;', 'Thing'],
  ])('the signature scanner reads %s', (_label, src, expected) => {
    expect(declaredFunctions(src).map((fn) => fn.returns)).toEqual([expected]);
  });

  it('finds declared functions to check (guards against a broken scan)', () => {
    expect(functions.length).toBeGreaterThan(20);
    const factory = functions.find((fn) => fn.name === 'toolDepsFor');
    expect(factory?.returns).toBe('ToolDeps');
    expect(functions.find((fn) => fn.name === 'registerTools')?.params).toContain('ToolDeps');
  });

  it('exports a constructor for every exported type its exported functions demand', () => {
    // A type is ORPHANED when this package knows how to build it and ships none of those builders.
    // An internal helper that merely happens to produce one is not a constructor: what matters is
    // whether ANY sanctioned way in exists.
    const builders = new Map<string, Declared[]>();
    for (const fn of functions) builders.set(fn.returns, [...(builders.get(fn.returns) ?? []), fn]);
    const orphaned = [...builders]
      .filter(([type, fns]) => exposed.has(type) && !fns.some((fn) => exposed.has(fn.name)))
      .map(([type]) => type);

    const offenders: string[] = [];
    for (const fn of functions) {
      if (!exposed.has(fn.name)) continue;
      for (const type of orphaned) {
        if (new RegExp(`\\b${type}\\b`).test(fn.params))
          offenders.push(`${fn.file}: ${fn.name}() takes ${type}, whose only builder index.ts withholds`);
      }
    }
    expect(
      offenders,
      'export the factory too, or withhold the type — a consumer handed a type it cannot legally build assembles it by hand and breaks on the next field added to it',
    ).toEqual([]);
  });

  /**
   * The mirror of the rule above: a type the barrel ships that no shipped function names at all. It
   * is not merely useless — a consumer who can name `RosterEntry` but cannot obtain, parse or hand
   * one back reaches into this package's unpublished `src/` to work around it, which `files: ["dist"]`
   * does not even publish. Derive the pairs from the barrel's own `engine/`/`transport/` clauses, so
   * the next type added there without a producer fails here without anyone naming it.
   */
  const ENGINE_CLAUSE = /export\s+\{([^}]*)\}\s+from\s+'(\.\/(?:engine|transport)\/[^']+)'/g;
  const barrelTypes = [...barrel.matchAll(ENGINE_CLAUSE)].flatMap(([, clause, module]) =>
    clause!
      .split(',')
      .map((spec) => spec.trim())
      .filter((spec) => spec.startsWith('type '))
      .map((spec) => ({
        module: module!,
        name: spec.replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim(),
      })),
  );

  it('finds re-exported engine/transport types to check (guards against a broken scan)', () => {
    expect(barrelTypes.length).toBeGreaterThan(5);
    expect(barrelTypes.map((t) => t.name)).toContain('CatchUpArgs'); // an inline `type` specifier
    expect(barrelTypes.map((t) => t.name)).toContain('ToolDeps'); // a multi-line clause
  });

  it('names every engine/transport type it exports in a function it also exports', () => {
    const shipped = functions.filter((fn) => exposed.has(fn.name));
    const offenders = barrelTypes
      .filter(
        ({ name }) =>
          !shipped.some((fn) => new RegExp(`\\b${name}\\b`).test(`${fn.params} ${fn.returns}`)),
      )
      .map(({ name, module }) => `${name} (from ${module}) is exported with no exported producer or consumer`);
    expect(
      offenders,
      'withhold the type, or export the function that produces or consumes it — a type with no reachable API sends consumers into this package’s unpublished src/',
    ).toEqual([]);
  });
});
