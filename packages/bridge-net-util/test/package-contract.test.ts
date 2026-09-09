import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from '@sharptrick/parley-net-util';
import { DEFAULT_DEADLINE_MS, fetchWithRetry } from '@sharptrick/parley-net-util';
import { derivedRows, exportedNames } from '@sharptrick/parley-net-util/testing';
import {
  importedNames,
  importingFiles,
  packageDocs,
  packageSources,
  type SourceFile,
  SELF,
} from './consumers.js';
import {
  captureWaits,
  loop,
  README,
  rejects,
  res,
  resetGlobalsAfterEach,
  stubForever,
} from './fixtures.js';

resetGlobalsAfterEach();

/**
 * The PUBLISHED surface, runtime bindings unioned with the barrel's own type-only exports.
 * `Object.keys(api)` cannot see an `export interface` — a `.d.ts` name is a semver commitment with
 * no runtime key to enumerate — so a table built from it alone declared a type-only export
 * unpublished, and `export interface NobodyImportsThis` left the file at "118 tests" green.
 */
const BARREL = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

const SURFACE = derivedRows(
  'the published surface',
  () => [...new Set([...Object.keys(api), ...exportedNames(BARREL)])].sort(),
  { floor: 12, witness: ['fetchWithRetry', 'FetchWithRetryOptions'] },
);
// The README is the only description an npm consumer reads, and every exported name is a semver
// commitment. Generated from the entry point, so a new export fails until it is documented.
describe('README', () => {
  const readme = README;

  // `toContain(name)` over the whole file counts incidental prose as documentation: short names
  // like `delay` match a sentence that never mentions the export. Require the name in a code span.
  const asCodeSpan = (name: string): RegExp => new RegExp(`\`${name}(\`|\\()`);

  it.each(SURFACE)('documents the exported `%s`', (name) => {
    expect(readme).toMatch(asCodeSpan(name));
  });

  it('finds code spans at all, so the check above cannot pass by finding none', () => {
    expect(readme.split('`').length).toBeGreaterThan(20);
  });

  it('does not describe a publicly-published package as internal', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { description: string; publishConfig?: { access?: string } };
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.description.toLowerCase()).not.toContain('internal');
    expect(readme.toLowerCase()).not.toMatch(/exports exactly two things/);
  });

  // The README states a bound and names a constant as the thing that enforces it. Derive the
  // prediction FROM the README and compare it with what the helper does, so that naming a constant
  // which is not the governing one fails the doc — not only the row where the code disagrees.
  describe('the stated-wait rule the README documents is the one the code runs', () => {
    const sentence = (): string => {
      const hits = readme
        .split(/(?<=\.)\s+/)
        .filter((s) => /ends? the call|ending the call/.test(s));
      expect(hits).toHaveLength(1);
      return hits[0] as string;
    };

    /**
     * The knob the README's own sentence claims decides it, resolved to a figure. Held as a table
     * of candidates rather than as `DEFAULT_DEADLINE_MS`, so that a sentence renaming the governor
     * fails the lookup instead of silently grading the deadline it no longer names.
     */
    const GOVERNORS: Record<string, number> = { deadlineMs: DEFAULT_DEADLINE_MS };

    const documentedThreshold = (): number => {
      const s = sentence();
      const names = Object.keys(GOVERNORS).filter((n) => s.includes(n));
      expect(names).toHaveLength(1); // exactly one constant is claimed to govern
      return GOVERNORS[names[0] as string] as number;
    };

    it.each([2_000, 6_000, 10_000, 60_000, 120_000])(
      'a %ims stated wait behaves as the README predicts',
      async (requestedMs) => {
        const predicted = requestedMs > documentedThreshold() ? 'stop' : 'retry';
        const state = stubForever(() => res(429, '', { 'retry-after': String(requestedMs / 1000) }));
        captureWaits();
        let clock = 0;
        const err = await rejects(
          fetchWithRetry('https://x/y', {}, loop({ maxAttempts: 4, now: () => (clock += 1) })),
        );
        const actual = state.calls === 1 ? 'stop' : 'retry';
        expect(actual).toBe(predicted);
        if (predicted === 'stop') expect(err.message).toMatch(/past this call's 30000ms deadline/);
      },
    );
  });

  // The mechanism the loop actually runs, against what the docs attribute to it. `fetchWithRetry`
  // has never clamped anything — the only backoff it invents is the fixed `DEFAULT_BACKOFF_MS` —
  // while the npm description sold a "backoff clamp" as one of its features, the README named
  // `MAX_BACKOFF_MS` as one of the loop's own bounds, and three backends' READMEs documented the
  // clamp as their own rate-limit behaviour. The clamp is gone; the names are what the docs may not
  // reintroduce without the mechanism.
  describe('the docs attribute to the loop only what the loop reaches', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      description: string;
    };
    const CLAMP_NAMES = ['clampBackoff', 'MAX_BACKOFF_MS'];

    /** Comments stripped, so a name discussed in prose does not read as code. */
    const loopCode = (): string =>
      src.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

    /** Mentions that are a USE, i.e. everything but the name's own `export` line. */
    const uses = (name: string, text: string): number =>
      [...text.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length -
      [...text.matchAll(new RegExp(`export (?:const|function) ${name}\\b`, 'g'))].length;

    it('finds the loop, so the rows below are not reading an empty string', () => {
      expect(loopCode()).toContain('export async function fetchWithRetry');
      expect(loopCode().length).toBeGreaterThan(1_000);
      expect(uses('DEFAULT_BACKOFF_MS', loopCode())).toBeGreaterThan(0);
    });

    // Sold on the npm page, where nobody can check it against the code.
    it.each(['backoff clamp', ...CLAMP_NAMES])('the npm description does not advertise "%s"', (claim) => {
      expect(pkg.description).not.toContain(claim);
    });

    it.each(CLAMP_NAMES)('the README does not name `%s` either', (name) => {
      expect(readme).not.toContain(name);
    });
  });

  // Shipped metadata that enumerates a set the repo already knows: re-derive it rather than pin
  // today's list, so a backend that gains or drops the dependency moves the README with it.
  describe('the consumer set is the real dependency graph', () => {
    const packagesDir = new URL('../../', import.meta.url);
    const SELF = '@sharptrick/parley-net-util';
    const SUITE = '@sharptrick/parley-conformance';

    /**
     * A package is a backend iff it is GRADED by the shared conformance suite. Derived from the
     * manifests, not from the `bridge-*` directory prefix: that prefix needed a growing exception
     * list (`bridge-core`, this package) because it names a naming convention rather than the
     * property, and the next non-backend added under it would have joined the set silently.
     */
    const backends = (): { dir: string; consumes: boolean }[] =>
      readdirSync(packagesDir)
        .map((dir) => {
          try {
            return {
              dir,
              pkg: JSON.parse(
                readFileSync(new URL(`${dir}/package.json`, packagesDir), 'utf8'),
              ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
            };
          } catch {
            return undefined;
          }
        })
        .filter((v): v is { dir: string; pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } } => v !== undefined)
        .map(({ dir, pkg }) => ({
          dir,
          deps: { ...pkg.dependencies, ...pkg.devDependencies },
          // Whether a backend CONSUMES this package is a question about the shipped graph, so it is
          // answered from `dependencies` alone: importing the test corpus from a devDependency is
          // not a runtime dependency and does not belong in the README's consumer set.
          runtime: { ...pkg.dependencies },
        }))
        .filter(({ deps }) => SUITE in deps)
        .sort((a, b) => a.dir.localeCompare(b.dir))
        .map(({ dir, runtime }) => ({ dir, consumes: SELF in runtime }));

    it('derives a backend set that is neither empty nor this package', () => {
      expect(backends().length).toBeGreaterThan(5);
      expect(backends().map((b) => b.dir)).not.toContain('bridge-net-util');
      expect(backends().map((b) => b.dir)).not.toContain('bridge-core');
    });

    const listed = (heading: string): string[] => {
      const line = readme.split('\n').find((l) => l.includes(`**${heading}:**`));
      expect(line, `README has no "${heading}:" line`).toBeDefined();
      return (line as string)
        .replace(/^.*\*\*.*?:\*\*/, '')
        .replace(/\.\s*$/, '')
        .split(',')
        .map((n) => n.trim().toLowerCase())
        .filter((n) => n.length > 0)
        .sort();
    };

    it('names every backend that depends on this package, and no other', () => {
      const expected = backends()
        .filter((b) => b.consumes)
        .map((b) => b.dir.replace('bridge-', ''))
        .sort();
      expect(listed('Consumed by')).toEqual(expected);
    });

    it('names every backend that does NOT depend on this package, and no other', () => {
      const expected = backends()
        .filter((b) => !b.consumes)
        .map((b) => b.dir.replace('bridge-', ''))
        .sort();
      expect(listed('Not consumed by')).toEqual(expected);
    });

    // The npm `description` is read where nobody can check it against the repo, so it may not
    // enumerate at all — an unnamable set cannot go stale.
    it('the npm description enumerates no backend', () => {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        description: string;
      };
      const named = backends()
        .map((b) => b.dir.replace('bridge-', ''))
        .filter((n) => pkg.description.toLowerCase().includes(n));
      expect(named).toEqual([]);
    });
  });
});

/**
 * A default is what a consumer gets by NOT passing the option, so a suite that always passes the
 * option grades a figure nobody ships with. `MAX_RESPONSE_BYTES` was in exactly that state: cutting
 * it from 16 MiB to 1 KB left every case in this package green and broke 262 across 26 others — the
 * package that owns the constant could not name the regression it caused. Derived from the exported
 * numbers rather than a list, so the next default arrives classified or fails here.
 */
describe('every shipped default is graded on the path it governs', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

  /** Each exported default, and the option a caller overrides it with (`none`: it cannot be). */
  const GOVERNED_OPTIONS: Record<string, string> = {
    DEFAULT_MAX_ATTEMPTS: 'maxAttempts',
    DEFAULT_DEADLINE_MS: 'deadlineMs',
    MAX_RESPONSE_BYTES: 'maxBodyBytes',
    MAX_BODY_WAIT_MS: 'none',
    DEFAULT_BACKOFF_MS: 'none',
    MAX_ERROR_BODY: 'none',
    STOP_POLL_MS: 'none',
  };

  const exportedDefaults = (): string[] =>
    Object.entries(api)
      .filter(([name, value]) => typeof value === 'number' && /^[A-Z][A-Z0-9_]*$/.test(name))
      .map(([name]) => name);

  /** The options `fetchWithRetry` actually takes, read off the declaration. */
  const declaredOptions = (): string[] => {
    const from = src.indexOf('export interface FetchWithRetryOptions {');
    const block = src.slice(from, src.indexOf('\n}', from));
    return [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as string);
  };

  /**
   * The figure the README states beside each constant. A default is graded in two places — what the
   * code does with it, and what the published page promises it is — and the second was pinned
   * nowhere, so a constant could move with the npm page still quoting the old number.
   */
  const documentedFigures = (): [string, number][] =>
    [...README.matchAll(/`([A-Z][A-Z0-9_]*)` \(([\d_]+)( MiB)?/g)].map(([, name, digits, mib]) => [
      name as string,
      Number((digits as string).replaceAll('_', '')) * (mib === undefined ? 1 : 1024 * 1024),
    ]);

  it('finds the defaults, the options and the figures, so the rows below grade something', () => {
    expect(exportedDefaults().length).toBeGreaterThan(4);
    expect(declaredOptions()).toContain('label');
    expect(documentedFigures().length).toBeGreaterThan(4);
  });

  it.each(exportedDefaults())('`%s` is classified as governing an option, or not', (name) => {
    expect(
      Object.keys(GOVERNED_OPTIONS),
      `\`${name}\` is a shipped default nothing here classifies — name the option it governs, or ` +
        `\`none\` if a caller cannot override it`,
    ).toContain(name);
  });

  it.each(Object.entries(GOVERNED_OPTIONS).filter(([, option]) => option !== 'none'))(
    '`%s` governs the real option `%s`',
    (_name, option) => {
      expect(declaredOptions()).toContain(option);
    },
  );

  it.each(documentedFigures())('the README states %s as %i, which is what it is', (name, figure) => {
    expect((api as unknown as Record<string, unknown>)[name]).toBe(figure);
  });
});

/**
 * Every export here is a semver commitment the whole workspace publishes in lockstep, so a name no
 * consumer imports is a promise kept for nobody. `clampBackoff` reached this state unnoticed: its
 * only trace outside this package was a COMMENT in a backend describing behaviour it does not have.
 * Derived from the entry point rather than a list, so the next dead export fails here instead of
 * shipping by default — and keeping one is a decision that has to be written down.
 */
describe('every export earns its place', () => {
  const INTENTIONALLY_UNCONSUMED: Record<string, string> = {
    DEFAULT_MAX_ATTEMPTS: 'the documented default of FetchWithRetryOptions.maxAttempts',
    FetchWithRetryOptions:
      'the options type of this package\'s one exported call — a consumer that names the type of ' +
      'the object it builds needs it, and a backend that spreads a literal at the call site does not',
    MAX_BODY_WAIT_MS:
      'the ceiling this loop applies to a body-stated wait before adopting it — a figure a ' +
      'consumer diagnosing an ignored hint has to be able to name, not override',
    MAX_RESPONSE_BYTES: 'the documented default of FetchWithRetryOptions.maxBodyBytes',
    retryAfterFromHeader:
      'the RFC 9110 header parse, both forms — the FLOOR every `bodyRetryAfter` hook is built on ' +
      'and the whole answer for a vendor that states no body hint',
    STOP_POLL_MS: 'the documented bound on how long disconnect waits on a backoff',
  };

  const consumers = (name: string): string[] =>
    importingFiles()
      .filter((file) => importedNames(file).has(name))
      .map(({ path }) => path);

  it('finds consumers at all, so the rows below are not reading an empty set', () => {
    expect(importingFiles().length).toBeGreaterThan(5);
    expect(consumers('fetchWithRetry').length).toBeGreaterThan(3);
    expect(Object.keys(api).length).toBeGreaterThan(5);
  });

  /**
   * The RULER, on a synthetic tree rather than on `packages/`. A file that merely SPELLS a name is
   * not a consumer of it, and reading the whole text of an importing file said otherwise: appending
   * `export const label = 1;` — imported by nothing — PASSED this guard, because `label` is the
   * spelling of a property at half a dozen call sites. A broken ruler here does not fail; it reports
   * a surface that is not the surface.
   */
  describe('what counts as a consumer', () => {
    const NO_SELF_DIR = 'nothing-here';
    const plant = (files: Record<string, string>): URL => {
      const root = pathToFileURL(`${mkdtempSync(join(tmpdir(), 'net-util-consumes-'))}/`);
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(new URL(`./${dirname(path)}/`, root), { recursive: true });
        writeFileSync(new URL(`./${path}`, root), body);
      }
      return root;
    };

    const namesImported = (files: Record<string, string>): string[] => [
      ...new Set(
        importingFiles(plant(files), NO_SELF_DIR).flatMap((file) => [...importedNames(file)]),
      ),
    ];

    it('counts a name where it is imported and not where it is only spelled', () => {
      const seen = namesImported({
        'consumer/src/uses.ts': `import { fetchWithRetry } from '${SELF}';\nvoid fetchWithRetry;\n`,
        'consumer/src/spells.ts':
          `import { delay } from '${SELF}';\n` +
          'const opts = { label: 1, sanitizeBody: 2 };\nvoid opts;\nvoid delay;\n',
      });
      expect(seen).toContain('fetchWithRetry');
      expect(seen).toContain('delay');
      expect(seen, 'a property spelled like an export counted as importing it').not.toContain(
        'label',
      );
      expect(seen).not.toContain('sanitizeBody');
    });

    /**
     * The import grammar, EXHAUSTIVELY, each form saying whether the scan covers it. The row this
     * replaced was titled "counts an alias, a type-only import, and a namespace read" and covered
     * only the INLINE `{ type X }` — `import type { X } from` and `export { X } from` bind a name
     * exactly as much and were both missed, so a consumer written either way read as importing
     * nothing at all.
     *
     * A form marked `covered: false` is a stated blind spot, not an oversight: `export *` names
     * nothing to count, and a computed namespace read is not statically a name. Both make a live
     * import look dead, which fails toward "delete an export somebody uses" — so they are recorded
     * here rather than papered over with a looser regex that would start counting spellings.
     */
    const NAME = 'statusOf';
    const IMPORT_GRAMMAR: Array<[form: string, source: string, covered: boolean]> = [
      ['a named import', `import { ${NAME} } from '${SELF}';\nvoid ${NAME};\n`, true],
      ['an aliased import', `import { ${NAME} as s } from '${SELF}';\nvoid s;\n`, true],
      ['an inline type-only specifier', `import { type ${NAME} } from '${SELF}';\n`, true],
      ['a type-only import statement', `import type { ${NAME} } from '${SELF}';\n`, true],
      ['a named re-export', `export { ${NAME} } from '${SELF}';\n`, true],
      ['a type-only re-export', `export type { ${NAME} } from '${SELF}';\n`, true],
      [
        'a namespace import read by property',
        `import * as net from '${SELF}';\nvoid net.${NAME};\n`,
        true,
      ],
      [
        'a dynamic import read by property',
        `const net = await import('${SELF}');\nvoid net.${NAME};\n`,
        true,
      ],
      [
        'a vitest mock reaching the real module',
        `type NetUtil = typeof import('${SELF}');\n` +
          'const actual = await importOriginal<NetUtil>();\n' +
          `void actual.${NAME};\n`,
        true,
      ],
      ['a star re-export', `export * from '${SELF}';\n`, false],
      [
        'a computed namespace read',
        `import * as net from '${SELF}';\nvoid net['${NAME}'];\n`,
        false,
      ],
    ];

    it.each(IMPORT_GRAMMAR)('%s binds a countable name: %s', (_form, source, covered) => {
      expect(namesImported({ 'consumer/src/shapes.ts': source }).includes(NAME)).toBe(covered);
    });

    it('counts an alias and a namespace read in the same file, under their real names', () => {
      const seen = namesImported({
        'consumer/src/shapes.ts':
          `import { type FetchWithRetryOptions, HttpStatusError as Boom } from '${SELF}';\n` +
          `import * as net from '${SELF}';\n` +
          'void net.statusOf;\ndeclare const o: FetchWithRetryOptions;\nvoid o;\nvoid Boom;\n',
      });
      expect(seen.sort()).toEqual(['FetchWithRetryOptions', 'HttpStatusError', 'statusOf']);
    });

    it('counts nothing in a file that only names the package in a string', () => {
      expect(
        namesImported({
          'lister/src/table.ts': `const FORBIDDEN = ['${SELF}'];\nvoid FORBIDDEN;\n`,
        }),
      ).toEqual([]);
    });
  });

  /**
   * A name kept for nobody is kept on the strength of a REASON, and the reason is only true while
   * no consumer believes otherwise. `clampBackoff` had zero callers and TWO packages documenting it
   * as live — a comment in zulip's wire and one in matrix's rate-limit test — while its recorded
   * reason ("the applier of MAX_BACKOFF_MS, which three backends read and two document by name")
   * was a true statement about MAX_BACKOFF_MS, which was not the excused entry. Nothing could see
   * the gap, because the dead-export check reads IMPORTS and prose is not one.
   *
   * So: outside this package, every mention of an excused name must be an import, or must say the
   * name is not reached. Describing one as live is the failure mode, and it is the only one prose
   * can commit.
   */
  const DISCLAIMED =
    /\b(?:does not|do not|never|no longer|not)\b[^.]{0,140}?\b(?:call|calls|reach|reaches|use|uses|apply|applies|import|imports)\b/i;

  const mentionSources = (): SourceFile[] => [...packageSources(['src', 'test']), ...packageDocs()];

  const unexcusedMentions = (name: string, files: SourceFile[]): string[] => {
    const out: string[] = [];
    for (const file of files) {
      if (!file.text.includes(name) || importedNames(file).has(name)) continue;
      for (const sentence of file.text.split(/(?<=[.!?])\s+|\n\n/)) {
        if (sentence.includes(name) && !DISCLAIMED.test(sentence))
          out.push(`${file.path}: ${sentence.trim().replaceAll(/\s+/g, ' ').slice(0, 140)}`);
      }
    }
    return out;
  };

  /** The RULER: a mention that describes the name as live, and one that denies it. */
  it('reads prose about an unconsumed name, so the rows below are not finding nothing', () => {
    const live: SourceFile = {
      pkg: 'p',
      path: 'p/src/wire.ts',
      text: '// the shared ceiling stays in clampBackoff rather than per backend.\n',
      code: '',
    };
    const denied: SourceFile = {
      pkg: 'p',
      path: 'p/src/wire.ts',
      text: '// the loop does not call clampBackoff.\n',
      code: '',
    };
    expect(unexcusedMentions('clampBackoff', [live])).toHaveLength(1);
    expect(unexcusedMentions('clampBackoff', [denied])).toEqual([]);
  });

  it.each(Object.keys(INTENTIONALLY_UNCONSUMED))(
    'every mention of `%s` outside this package is an import or a stated non-use',
    (name) => {
      expect(
        unexcusedMentions(name, mentionSources()),
        `a package describes \`${name}\` as something it reaches, and nothing imports it. Either ` +
          'the mention is wrong, or the name has a consumer and does not belong in ' +
          'INTENTIONALLY_UNCONSUMED',
      ).toEqual([]);
    },
  );

  it.each(SURFACE)('`%s` is imported somewhere, or kept on purpose', (name) => {
    const importers = consumers(name);
    if (importers.length > 0) {
      expect(
        INTENTIONALLY_UNCONSUMED[name],
        `\`${name}\` has consumers (${importers[0] as string}) — drop it from INTENTIONALLY_UNCONSUMED`,
      ).toBeUndefined();
      return;
    }
    expect(
      INTENTIONALLY_UNCONSUMED[name],
      `nothing under packages/*/src or packages/*/test imports \`${name}\` — delete it, or record ` +
        `in INTENTIONALLY_UNCONSUMED why this package still commits to the name`,
    ).toBeDefined();
  });
});
