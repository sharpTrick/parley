import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AUTH_DIR = fileURLToPath(new URL('.', import.meta.url));
const CORE_SRC = fileURLToPath(new URL('..', import.meta.url));

function tsFiles(dir: string, recurse = false): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) {
      if (recurse) out.push(...tsFiles(`${path}/`, true));
    } else if (entry.name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Lines that are wholly a comment — enough to catch the prose bands this guards against. */
function commentLines(source: string): Array<{ line: number; text: string }> {
  return source
    .split('\n')
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter((l) => l.text.startsWith('//') || l.text.startsWith('*') || l.text.startsWith('/*'));
}

/**
 * Comments that narrate history, cite review tickets, or argue with a future reviewer belong in the
 * commit message: they rot against the code and cannot be verified by anything. Each row is a shape
 * that has actually appeared in this package.
 */
const BANNED_COMMENT_SHAPES: Array<[string, RegExp]> = [
  ['a review/bug ticket reference', /\b(?:SEC|BUG|CX|D)-\d+\b/],
  ['a "Residual:" caveat aimed at a reviewer', /\bResidual:/],
  ['a "Latent ..." justification', /\bLatent\b/],
  ['a "We deliberately ..." defence of a past choice', /\bWe deliberately\b/i],
  ['a bare "Note:" preamble', /^(?:\/\/|\*)\s*Note:/i],
  ['an unresolved marker', /\b(?:TODO|FIXME|XXX|HACK)\b/],
];

describe('auth-layer comment discipline', () => {
  const files = tsFiles(AUTH_DIR);

  it('finds the auth sources to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(BANNED_COMMENT_SHAPES)('no comment carries %s', (_label: string, pattern: RegExp) => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { line, text } of commentLines(readFileSync(file, 'utf8'))) {
        if (pattern.test(text)) offenders.push(`${file}:${line}: ${text}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * A suite that decides whether to run from a runtime reachability probe reports a green,
 * named, meaningless test when the dependency is merely slow or briefly down — in the same CI
 * job that claims to verify it. Opting out must be explicit.
 */
describe('no suite may skip itself into green', () => {
  const files = tsFiles(CORE_SRC, true).filter((f) => f.endsWith('.test.ts'));

  it('finds the core test files to scan', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [f.slice(CORE_SRC.length), f]))(
    '%s gates any skip on an explicit env opt-out, not on a probe',
    (_name: string, file: string) => {
      const source = readFileSync(file, 'utf8');
      if (!/describe\.skip|describe\.skipIf|it\.skip/.test(source)) return;
      expect(source, `${file} selects a skip without an explicit env opt-out`).toMatch(
        /process\.env\./,
      );
    },
  );
});
