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
 * A REGRESSION guard, not an enforcement of CLAUDE.md's comment discipline — that rule is about
 * what a comment is FOR, which no regex decides. Each row is one phrasing that actually appeared in
 * this package and was removed, so it cannot come back unnoticed; a comment narrating history in
 * any other words walks straight past all six, and a human reader is what catches that.
 */
const BANNED_COMMENT_SHAPES: Array<[string, RegExp]> = [
  ['a review/bug ticket reference', /\b(?:SEC|BUG|CX|D)-\d+\b/],
  ['a "Residual:" caveat aimed at a reviewer', /\bResidual:/],
  ['a "Latent ..." justification', /\bLatent\b/],
  ['a "We deliberately ..." defence of a past choice', /\bWe deliberately\b/i],
  ['a bare "Note:" preamble', /^(?:\/\/|\*)\s*Note:/i],
  ['an unresolved marker', /\b(?:TODO|FIXME|XXX|HACK)\b/],
];

describe('auth-layer comments never regain a phrasing this package has already removed', () => {
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

  // Every row is a pattern nothing in the package matches, which is also what a pattern matching
  // NOTHING AT ALL looks like: a row whose regex has quietly stopped compiling to what it reads as
  // would pass forever. Prove each one still fires on the phrasing it names.
  const SAMPLE_OFFENDERS: Array<[string, string]> = [
    ['a review/bug ticket reference', '// see SEC-123 for the discussion'],
    ['a "Residual:" caveat aimed at a reviewer', '// Residual: the reviewer wanted a second pass'],
    ['a "Latent ..." justification', '// Latent risk, accepted for now'],
    ['a "We deliberately ..." defence of a past choice', '// We deliberately kept the old path'],
    ['a bare "Note:" preamble', '// Note: this is the interesting bit'],
    ['an unresolved marker', '// TODO: come back to this'],
  ];

  it.each(BANNED_COMMENT_SHAPES)('%s is a pattern that still matches its own shape', (label: string, pattern: RegExp) => {
    const sample = SAMPLE_OFFENDERS.find(([l]) => l === label)?.[1];
    expect(sample, `no sample offender written for "${label}"`).toBeDefined();
    expect(pattern.test(sample!)).toBe(true);
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
 *
 * The selection happens when the TABLE is built, not inside the test body: a row that returns
 * before asserting is green for a reason nothing records, and thirty-nine such rows made one real
 * check look like forty.
 */
const SELECTS_A_SKIP = /describe\.skip|describe\.skipIf|it\.skip/;

describe('no suite may skip itself into green', () => {
  const files = tsFiles(CORE_SRC, true).filter((f) => f.endsWith('.test.ts'));
  const skipping = files.filter((f) => SELECTS_A_SKIP.test(readFileSync(f, 'utf8')));

  it('finds the core test files to scan, and at least one that selects a skip', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(skipping.length).toBeGreaterThan(0);
  });

  it.each(skipping.map((f) => [f.slice(CORE_SRC.length), f]))(
    '%s gates its skip on an explicit env opt-out, not on a probe',
    (_name: string, file: string) => {
      expect(
        readFileSync(file, 'utf8'),
        `${file} selects a skip without an explicit env opt-out`,
      ).toMatch(/process\.env\./);
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

  // The claim is about paragraphs that talk about SKIPPING, so that is what the table holds — a row
  // that returns before asserting because its paragraph never mentioned a skip counts a paragraph
  // naming a suite, which is a different and much larger set.
  const CLAIMING_A_SKIP = REFERENCES.filter(([, , paragraph]) => /\bskip/i.test(paragraph));

  it('finds at least one doc paragraph naming an e2e suite, and one claiming a skip', () => {
    expect(REFERENCES.length).toBeGreaterThan(0);
    expect(CLAIMING_A_SKIP.length).toBeGreaterThan(0);
  });

  it.each(CLAIMING_A_SKIP)(
    '%s names every env switch its suite gates on',
    (_name: string, switches: string[], paragraph: string) => {
      expect(switches.length).toBeGreaterThan(0);
      for (const name of switches) {
        expect(paragraph, `claims a skip without naming ${name}`).toContain(name);
      }
    },
  );
});
