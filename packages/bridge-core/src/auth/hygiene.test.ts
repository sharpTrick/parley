import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AUTH_DIR = fileURLToPath(new URL('.', import.meta.url));
const CORE_SRC = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

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
 * A symbol the barrel re-exports is something an operator can call directly, so the config
 * schema's rules are not in front of it — whatever guards it must live in the function and be
 * driven by a test. An entry point whose only coverage is an env-gated e2e file has none in the
 * offline gate that decides whether a change lands.
 */
function importedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/[\w.-]+\.js'/g)) {
    for (const raw of (match[1] ?? '').split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
      if (name !== undefined && name !== '') names.add(name);
    }
  }
  return names;
}

function barrelExportedAuthValues(): string[] {
  const barrel = readFileSync(`${CORE_SRC}index.ts`, 'utf8');
  const out: string[] = [];
  for (const match of barrel.matchAll(/export\s*\{([^}]*)\}\s*from\s*'\.\/auth\/[\w.-]+\.js'/g)) {
    for (const raw of (match[1] ?? '').split(',')) {
      const entry = raw.trim();
      if (entry === '' || entry.startsWith('type ')) continue;
      out.push(entry.split(/\s+as\s+/)[0]!);
    }
  }
  return out;
}

describe('every public auth entry point is driven by the offline suite', () => {
  const covered = new Set<string>();
  for (const file of tsFiles(AUTH_DIR)) {
    if (!file.endsWith('.test.ts') || file.endsWith('.e2e.test.ts')) continue;
    for (const name of importedNames(readFileSync(file, 'utf8'))) covered.add(name);
  }

  const exported = barrelExportedAuthValues();

  it('finds the barrel auth exports to scan', () => {
    expect(exported.length).toBeGreaterThan(5);
  });

  it.each(exported.map((n) => [n]))(
    '%s is imported by a test that runs without a live IdP',
    (name: string) => {
      expect(covered.has(name), `${name} is re-exported from src/index.ts but no non-e2e auth test imports it`).toBe(true);
    },
  );
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

function filesUnder(dir: string, ending: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(`${path}/`, ending));
    else if (entry.name.endsWith(ending)) out.push(path);
  }
  return out;
}

/**
 * The gate above is only half of the promise: the other half is what the docs tell a contributor
 * it does. A paragraph claiming an e2e suite skips itself, while the suite fails instead, sends
 * someone to debug a red run the doc told them could not happen — so a paragraph naming a suite
 * may talk about skipping only if it also names every switch that suite reads. Driven off the file
 * list rather than a hardcoded pair, a new e2e suite and a new doc are covered the day they land.
 * docs/findings/ is excluded: those files are a frozen record of what a reviewer said, not a claim
 * this repo is making.
 */
describe('no doc describes an e2e gate the suite does not implement', () => {
  const suites = filesUnder(`${REPO_ROOT}packages/`, '.e2e.test.ts');
  const docs = filesUnder(REPO_ROOT, '.md').filter((f) => !f.includes('/docs/findings/'));

  it('finds the e2e suites and the docs that could describe them', () => {
    expect(suites.length).toBeGreaterThan(0);
    expect(docs.length).toBeGreaterThan(5);
  });

  const REFERENCES = suites.flatMap((suite) => {
    const rel = suite.slice(REPO_ROOT.length);
    const switches = [
      ...new Set(
        [...readFileSync(suite, 'utf8').matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]!),
      ),
    ];
    return docs.flatMap((doc) =>
      readFileSync(doc, 'utf8')
        .split(/\n[ \t]*\n/)
        .map((paragraph, i): [string, string[], string] => [
          `${doc.slice(REPO_ROOT.length)} paragraph ${i} on ${rel}`,
          switches,
          paragraph,
        ])
        .filter(([, , paragraph]) => paragraph.includes(rel)),
    );
  });

  it('finds at least one doc paragraph naming an e2e suite', () => {
    expect(REFERENCES.length).toBeGreaterThan(0);
  });

  it.each(REFERENCES)(
    '%s names every env switch it gates on, if it claims a skip at all',
    (_name: string, switches: string[], paragraph: string) => {
      if (!/\bskip/i.test(paragraph)) return;
      for (const name of switches) {
        expect(paragraph, `claims a skip without naming ${name}`).toContain(name);
      }
    },
  );
});
