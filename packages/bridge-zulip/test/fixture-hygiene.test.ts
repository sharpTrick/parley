/**
 * CLASS: a wire shape restated in more than one test file is drift waiting to happen — correcting
 * the shape in one file leaves the other grading a body the server never produces, and both stay
 * green. The fault vocabulary therefore lives beside the fake that serves it ({@link FAULTS}), and
 * this lints every test file for an inline shape handed to a fault injector that another file also
 * spells out, so the check widens as fault shapes are added instead of pinning today's four.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FAULTS } from './fake-zulip.js';

const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));
const TEST_FILES = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts'));

/** Every fake entry point that takes a server fault; an argument literal to one is a wire shape. */
const INJECTORS = ['failRoute', 'hangRoute', 'rateLimit', 'holdResponse'] as const;

/** The argument text of each `injector(...)` call, quotes and nesting respected. */
function callArguments(source: string, injector: string): string[] {
  const out: string[] = [];
  const call = new RegExp(`\\b${injector}\\s*\\(`, 'g');
  for (let m = call.exec(source); m !== null; m = call.exec(source)) {
    let depth = 1;
    let quote = '';
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i] as string;
      if (quote !== '') {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
    }
    out.push(source.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

/** Object literals inside one argument list, whitespace-normalized so formatting is not identity. */
function shapesIn(args: string): string[] {
  const shapes: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '{') continue;
    let depth = 0;
    let end = i;
    for (; end < args.length; end++) {
      if (args[end] === '{') depth++;
      else if (args[end] === '}' && --depth === 0) break;
    }
    shapes.push(args.slice(i, end + 1).replace(/\s+/g, ''));
    i = end;
  }
  return shapes;
}

/** shape → the files that spell it out inline. */
const INLINE_SHAPES = ((): Map<string, Set<string>> => {
  const found = new Map<string, Set<string>>();
  for (const file of TEST_FILES) {
    const source = readFileSync(`${TEST_DIR}${file}`, 'utf8');
    for (const injector of INJECTORS) {
      for (const args of callArguments(source, injector)) {
        for (const shape of shapesIn(args)) {
          found.set(shape, (found.get(shape) ?? new Set()).add(file));
        }
      }
    }
  }
  return found;
})();

describe('zulip test fixtures are shared, not restated', () => {
  it('finds the fault injections it lints, across more than one file', () => {
    const files = new Set([...INLINE_SHAPES.values()].flatMap((f) => [...f]));
    expect(INLINE_SHAPES.size).toBeGreaterThan(0);
    expect(files.size).toBeGreaterThan(1);
  });

  it('no fault shape is spelled out inline in two test files', () => {
    const restated = [...INLINE_SHAPES]
      .filter(([, files]) => files.size > 1)
      .map(([shape, files]) => `${[...files].join(' + ')}: ${shape}`);
    expect(restated).toEqual([]);
  });

  it('the shared vocabulary is the one the fake serves, and every entry is used', () => {
    const used = new Set(
      TEST_FILES.flatMap((file) => {
        const source = readFileSync(`${TEST_DIR}${file}`, 'utf8');
        return [...source.matchAll(/FAULTS\.(\w+)/g)].map((m) => m[1] as string);
      }),
    );
    expect(Object.keys(FAULTS).filter((name) => !used.has(name))).toEqual([]);
  });
});
