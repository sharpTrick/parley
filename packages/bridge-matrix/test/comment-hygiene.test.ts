import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * CLASS: source comments must not narrate tracker history. A `BUG-nn` / `SEC-nn` / `issue #nn` tag
 * is unresolvable from the published package, and the paragraph attached to it is rationale that
 * CLAUDE.md routes to the commit message — where it cannot rot against the code it describes. The
 * same text living in a comment, a README and a JSDoc block is three copies that can disagree.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const TRACKER_TAG = /\b(BUG|SEC|CX|ISSUE)[-\s#]*\d+/i;

const sources = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

/** Every comment block in a file: consecutive `//` lines are one block, as is each `/** … *\/`. */
function commentBlocks(source: string): string[] {
  const blocks: string[] = [];
  let line: string[] = [];
  let doc: string[] | undefined;
  for (const raw of source.split('\n')) {
    const text = raw.trim();
    if (doc !== undefined) {
      doc.push(text.replace(/^\*+\/?/, '').replace(/\*\/$/, ''));
      if (text.endsWith('*/')) {
        blocks.push(doc.join(' '));
        doc = undefined;
      }
      continue;
    }
    if (text.startsWith('/*')) {
      doc = [text.replace(/^\/\*+/, '')];
      if (text.endsWith('*/')) {
        blocks.push(doc.join(' ').replace(/\*\/$/, ''));
        doc = undefined;
      }
      continue;
    }
    if (text.startsWith('//')) {
      line.push(text.slice(2));
      continue;
    }
    if (line.length > 0) {
      blocks.push(line.join(' '));
      line = [];
    }
  }
  if (line.length > 0) blocks.push(line.join(' '));
  return blocks;
}

/** How many consecutive words make a restated rationale rather than a coincidence of phrasing. */
const SPAN_WORDS = 12;

const words = (block: string): string[] =>
  block
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

/** Word spans that appear in more than one comment block of the same file. */
function restatedSpans(source: string): string[] {
  const seen = new Map<string, number>();
  const repeated = new Set<string>();
  commentBlocks(source).forEach((block, blockIndex) => {
    const w = words(block);
    for (let i = 0; i + SPAN_WORDS <= w.length; i++) {
      const span = w.slice(i, i + SPAN_WORDS).join(' ');
      const first = seen.get(span);
      if (first === undefined) seen.set(span, blockIndex);
      else if (first !== blockIndex) repeated.add(span);
    }
  });
  return [...repeated];
}

describe('source comments carry no tracker history', () => {
  it('finds the source files it is meant to scan', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  for (const file of sources) {
    it(`${file} names no tracker id`, () => {
      const offenders = readFileSync(join(SRC, file), 'utf8')
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => TRACKER_TAG.test(line));

      expect(offenders.map(({ n, line }) => `${file}:${n}: ${line.trim()}`)).toEqual([]);
    });
  }
});

/**
 * CLASS: a statement that exists only to name something. `void x;` emits no code, so it survives
 * purely on the comment above it — and nothing here requires the reference: the repo configures no
 * ESLint/Biome, and `tsconfig.base.json` sets neither `noUnusedLocals` nor `noUnusedParameters`. The
 * seam is what puts the parameter in the signature; what this backend does with it belongs in the
 * README and the commit message, not in a no-op with a footnote.
 */
const DEAD_REFERENCE = /^\s*void\s+[A-Za-z_$][\w$]*\s*;\s*$/;

describe('no statement exists only to reference a name', () => {
  it('tells a dead reference from a deliberately unawaited call', () => {
    expect(DEAD_REFERENCE.test('    void identity;')).toBe(true);
    expect(DEAD_REFERENCE.test('void loop();')).toBe(false);
    expect(DEAD_REFERENCE.test('    void this.pollBoundedSync(roomId, topic);')).toBe(false);
  });

  for (const file of sources) {
    it(`${file} has none`, () => {
      const offenders = readFileSync(join(SRC, file), 'utf8')
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => DEAD_REFERENCE.test(line));

      expect(offenders.map(({ n, line }) => `${file}:${n}: ${line.trim()}`)).toEqual([]);
    });
  }
});

/**
 * CLASS: one rationale, written once. A causal chain restated at three call sites is three copies
 * that can disagree, and the next change to the behaviour has to find all of them — which is exactly
 * the rot CLAUDE.md routes to the commit message.
 */
describe('no rationale is restated across comment blocks', () => {
  it('recognizes a restatement when it sees one', () => {
    const twice = '// one two three four five six seven eight nine ten eleven twelve\nconst a = 1;\n';
    expect(restatedSpans(twice + twice)).toHaveLength(1);
    expect(restatedSpans(twice)).toEqual([]);
  });

  for (const file of sources) {
    it(`${file} states each rationale once`, () => {
      expect(restatedSpans(readFileSync(join(SRC, file), 'utf8'))).toEqual([]);
    });
  }
});

/**
 * CLASS: a dead symbol must fail a check, not a reviewer's grep. An import nothing references
 * survives every gate this repo has — `tsconfig.base.json` sets neither `noUnusedLocals` nor
 * `noUnusedParameters`, and no ESLint/Biome is configured — while reading as a live dependency of
 * the code beside it, which invites a second, divergent implementation of what the real one already
 * owns. Scoped to this package's `src/`; the compiler flags would cover the monorepo at once.
 */

/** Every `import … from '…'` clause in a file, and the whole span each one occupies. */
const importClauses = (source: string): { clause: string; span: string }[] => {
  const out: { clause: string; span: string }[] = [];
  const re = /import\s+([\s\S]*?)\s+from\s+['"][^'"]*['"]/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    out.push({ clause: m[1]!, span: m[0] });
  }
  return out;
};

/** The local identifiers an import clause binds — aliases, defaults and namespaces included. */
function boundNames(clause: string): string[] {
  const named = /\{([\s\S]*)\}/.exec(clause);
  const outside = clause.replace(/\{[\s\S]*\}/, '').replace(/^type\s+/, '');
  const names = [
    ...(named?.[1] ?? '').split(','),
    ...outside.split(',').map((t) => t.replace(/^\s*\*\s+as\s+/, '')),
  ];
  return names
    .map((n) => n.trim().replace(/^type\s+/, ''))
    .map((n) => (/\s+as\s+/.test(n) ? n.split(/\s+as\s+/)[1]!.trim() : n))
    .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

/** Imported bindings whose identifier appears nowhere else in the file. */
function unusedImports(source: string): string[] {
  const clauses = importClauses(source);
  const body = clauses.reduce((acc, { span }) => acc.replace(span, ''), source);
  return clauses
    .flatMap(({ clause }) => boundNames(clause))
    .filter((name) => !new RegExp(`\\b${name}\\b`).test(body));
}

describe('no import is dead', () => {
  it('tells a dead import from a used one', () => {
    const src = "import { used, dead, other as alias } from 'x';\nconst a = used(alias);\n";
    expect(unusedImports(src)).toEqual(['dead']);
    expect(unusedImports("import type { T } from 'x';\nlet a: T;\n")).toEqual([]);
    expect(unusedImports("import * as ns from 'x';\nns.f();\n")).toEqual([]);
    expect(unusedImports("import * as ns from 'x';\n")).toEqual(['ns']);
  });

  for (const file of sources) {
    it(`${file} references every name it imports`, () => {
      expect(unusedImports(readFileSync(join(SRC, file), 'utf8'))).toEqual([]);
    });
  }
});
