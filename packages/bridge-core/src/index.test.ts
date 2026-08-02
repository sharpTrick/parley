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
  const TOP_DECL =
    /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const|let|function|async function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

  // Type-only re-exports are part of the shipped surface but carry no runtime binding, so read the
  // barrel's own export clauses rather than only `Object.keys(api)`.
  const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8');
  const exposed = new Set<string>(Object.keys(api));
  for (const clause of barrel.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const spec of clause[1]!.split(',')) {
      const name = spec.replace(/^\s*type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name) exposed.add(name);
    }

  const STRINGS = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

  interface DocBlock {
    /** The declaration a reader sees this doc ON: itself at depth 0, its enclosing one below. */
    owner: string | null;
    depth: number;
    doc: string;
  }

  interface Scan {
    blocks: DocBlock[];
    /** Names declared `export` at depth 0 — what makes a file part of the shipped surface. */
    exported: string[];
    /** Exported names with a runtime binding — the ones a `{@link}` could have been importable. */
    values: string[];
    /** Whether the brace walk returned to depth 0, i.e. whether the depths above mean anything. */
    balanced: boolean;
  }

  /**
   * Walk one source, attributing each doc block to the declaration it documents AT ANY DEPTH. A
   * doc on an interface member, an object-literal (zod schema) field or a class method ships into
   * `.d.ts` verbatim, exactly as a top-level one does; a scanner that attaches a block only to the
   * next line when that line is itself an `export` reads the top-level position and nothing else,
   * which is how `AllowlistOptions.postPatterns` came to link a constant the barrel withholds.
   */
  function scan(source: string): Scan {
    const blocks: DocBlock[] = [];
    const exported: string[] = [];
    const values: string[] = [];
    let block: string[] | null = null;
    let depth = 0;
    let top: string | null = null;
    for (const raw of source.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('/**')) block = [line];
      else if (block && (line.startsWith('*') || line.startsWith('*/'))) block.push(line);
      else {
        const declared = TOP_DECL.exec(line)?.[1];
        if (depth === 0 && declared !== undefined) {
          top = declared;
          if (EXPORT_DECL.test(line)) exported.push(declared);
          if (VALUE_DECL.test(line)) values.push(declared);
        }
        if (block) blocks.push({ owner: depth === 0 ? declared ?? null : top, depth, doc: block.join('\n') });
        block = null;
        const code = line.replace(STRINGS, '').replace(/\/\/.*$/, '');
        for (const ch of code) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
      }
    }
    return { blocks, exported, values, balanced: depth === 0 };
  }

  const files = sources(SRC);
  const scans = files.map((file) => [file.slice(SRC.length), scan(readFileSync(file, 'utf8'))] as const);
  const values = new Set<string>(scans.flatMap(([, s]) => s.values));

  /**
   * Which of a file's doc blocks a consumer can actually read. A top-level one ships when the
   * barrel names it; a NESTED one ships whenever the file contributes any public surface at all,
   * because the enclosing declaration need not be exported itself for its member docs to be
   * emitted — `config.ts`'s `ConfigObject` is private and its field docs land in `ConfigSchema`'s
   * shipped type.
   */
  function shippedBlocks(scan: Scan, importable: ReadonlySet<string>): DocBlock[] {
    const contributes = scan.exported.some((name) => importable.has(name));
    return scan.blocks.filter((b) =>
      b.depth === 0 ? b.owner !== null && importable.has(b.owner) : contributes,
    );
  }

  const WITHHELD = /\{@link\s+([A-Za-z_$][\w$]*)/g;

  function linkOffenders(scan: Scan, importable: ReadonlySet<string>, minted: ReadonlySet<string>): string[] {
    return shippedBlocks(scan, importable).flatMap((b) =>
      [...b.doc.matchAll(WITHHELD)]
        .map((m) => m[1]!)
        .filter((name) => minted.has(name) && !importable.has(name))
        .map((name) => `${b.owner ?? '<file>'}'s doc links ${name}, which index.ts does not export`),
    );
  }

  const documented = scans.flatMap(([file, s]) => shippedBlocks(s, exposed).map((b) => ({ file, ...b })));

  it('finds documented exports and exported values to check (guards against a broken walk)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(documented.length).toBeGreaterThan(20);
    expect(values.size).toBeGreaterThan(20);
    expect(values.has('safeName')).toBe(true);
    expect(scans.filter(([, s]) => !s.balanced).map(([file]) => file)).toEqual([]);
    // A scanner that reads only the top-level position satisfies every count above.
    expect(documented.filter((d) => d.depth > 0).length).toBeGreaterThan(20);
  });

  /**
   * Grade the scanner by doc POSITION, not by how many blocks it happens to find. Each row is a
   * source carrying one `{@link Withheld}` somewhere a `.d.ts` would carry it verbatim, and the
   * scanner has to name the owner a consumer reads it on and report it. A position missing from
   * this table is a position that can ship unread.
   */
  const PUBLIC = new Set(['Owner', 'Shipped']);
  const MINTED = new Set(['Withheld']);
  const POSITIONS: readonly (readonly [label: string, owner: string, source: string])[] = [
    ['a top-level export', 'Owner', '/** see {@link Withheld} */\nexport const Owner = 1;\n'],
    ['a one-line doc', 'Owner', '/** {@link Withheld} */\nexport const Owner = 1;\n'],
    [
      'an interface member',
      'Owner',
      'export interface Owner {\n  /** see {@link Withheld} */\n  field?: string;\n}\n',
    ],
    [
      'an object-literal member of a private const the barrel ships the type of',
      'Private',
      'export const Shipped = 1;\nconst Private = z.object({\n  /** see {@link Withheld} */\n  field: z.string(),\n});\n',
    ],
    [
      'a class method',
      'Owner',
      'export class Owner {\n  /** see {@link Withheld} */\n  method(): void {}\n}\n',
    ],
    [
      'a member nested two deep',
      'Owner',
      'export interface Owner {\n  nested: {\n    /** see {@link Withheld} */\n    field?: string;\n  };\n}\n',
    ],
    [
      'a member below a field whose default value carries braces',
      'Owner',
      'export interface Owner {\n  first?: Record<string, string>;\n  /** see {@link Withheld} */\n  second?: string;\n}\n',
    ],
  ];

  it.each(POSITIONS)('attributes %s to its owner and reports it', (_label, owner, source) => {
    const scanned = scan(source);
    expect(scanned.balanced).toBe(true);
    expect(scanned.blocks.filter((b) => b.doc.includes('Withheld')).map((b) => b.owner)).toEqual([owner]);
    expect(linkOffenders(scanned, PUBLIC, MINTED)).toHaveLength(1);
  });

  it('leaves a link alone when the symbol is importable, or the doc never ships', () => {
    expect(linkOffenders(scan('/** {@link Shipped} */\nexport const Owner = 1;\n'), PUBLIC, MINTED)).toEqual([]);
    expect(
      linkOffenders(scan('/** {@link Withheld} */\nexport const Private = 1;\n'), PUBLIC, MINTED),
    ).toEqual([]);
  });

  it('resolves every {@link} in a public doc comment to a public symbol', () => {
    const offenders = scans.flatMap(([file, s]) =>
      linkOffenders(s, exposed, values).map((row) => `${file}: ${row}`),
    );
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
