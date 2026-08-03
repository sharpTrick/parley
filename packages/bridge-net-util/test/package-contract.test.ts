import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as api from '@sharptrick/parley-net-util';
import {
  DEFAULT_DEADLINE_MS,
  fetchWithRetry,
  MAX_BACKOFF_MS,
} from '@sharptrick/parley-net-util';
import { importingFiles } from './consumers.js';
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
// The README is the only description an npm consumer reads, and every exported name is a semver
// commitment. Generated from the entry point, so a new export fails until it is documented.
describe('README', () => {
  const readme = README;

  // `toContain(name)` over the whole file counts incidental prose as documentation: short names
  // like `delay` match a sentence that never mentions the export. Require the name in a code span.
  const asCodeSpan = (name: string): RegExp => new RegExp(`\`${name}(\`|\\()`);

  it.each(Object.keys(api).sort())('documents the exported `%s`', (name) => {
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

    const documentedThreshold = (): number => {
      const s = sentence();
      const names = ['MAX_BACKOFF_MS', 'deadlineMs'].filter((n) => s.includes(n));
      expect(names).toHaveLength(1); // exactly one constant is claimed to govern
      return names[0] === 'MAX_BACKOFF_MS' ? MAX_BACKOFF_MS : DEFAULT_DEADLINE_MS;
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
  // while the npm description sold a "backoff clamp" as one of its features and the README named
  // `MAX_BACKOFF_MS` as one of the loop's own bounds. Derived from the source with the clamp helper
  // cut out, so wiring the clamp into the loop and advertising it again have to happen together.
  describe('the docs attribute to the loop only what the loop reaches', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      description: string;
    };
    const CLAMP_NAMES = ['clampBackoff', 'MAX_BACKOFF_MS'];

    /** Comments stripped, and the clamp helper — which is a plugin's tool, not the loop's — removed. */
    const loopCode = (): string => {
      const bare = src.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');
      const from = bare.indexOf('export function clampBackoff');
      const to = bare.indexOf('\n}', from);
      return bare.slice(0, from) + bare.slice(to + 2);
    };

    /** Mentions that are a USE, i.e. everything but the name's own `export` line. */
    const uses = (name: string, text: string): number =>
      [...text.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length -
      [...text.matchAll(new RegExp(`export (?:const|function) ${name}\\b`, 'g'))].length;

    it('finds the loop and the clamp, so the rows below are not reading an empty string', () => {
      expect(loopCode()).toContain('export async function fetchWithRetry');
      expect(loopCode().length).toBeGreaterThan(1_000);
      expect(uses('DEFAULT_BACKOFF_MS', loopCode())).toBeGreaterThan(0);
      expect(src).toContain('export function clampBackoff');
    });

    it.each(CLAMP_NAMES)('the loop does not reach `%s`', (name) => {
      expect(uses(name, loopCode())).toBe(0);
    });

    // Sold on the npm page, where nobody can check it against the code.
    it.each(['backoff clamp', ...CLAMP_NAMES])('the npm description does not advertise "%s"', (claim) => {
      expect(pkg.description).not.toContain(claim);
    });

    // Prose is the risk here, so the check is over the BULLET that names it: whichever bullet
    // mentions the clamp must be the one that says the loop does not apply it.
    it.each(CLAMP_NAMES)('every README bullet naming `%s` says the loop does not use it', (name) => {
      const bullets = readme.split(/\n(?=-\s)/).filter((b) => b.includes(name));
      expect(bullets.length).toBeGreaterThan(0);
      for (const bullet of bullets) {
        expect(bullet).toMatch(/never calls it|does not call them|not to anything `fetchWithRetry` does/);
      }
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
        .map(({ dir, pkg }) => ({ dir, deps: { ...pkg.dependencies, ...pkg.devDependencies } }))
        .filter(({ deps }) => SUITE in deps)
        .sort((a, b) => a.dir.localeCompare(b.dir))
        .map(({ dir, deps }) => ({ dir, consumes: SELF in deps }));

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
    DEFAULT_BACKOFF_MS: 'none',
    MAX_BACKOFF_MS: 'none',
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
    clampBackoff:
      'the applier of MAX_BACKOFF_MS, which three backends read and two document by name',
    DEFAULT_MAX_ATTEMPTS: 'the documented default of FetchWithRetryOptions.maxAttempts',
    MAX_RESPONSE_BYTES: 'the documented default of FetchWithRetryOptions.maxBodyBytes',
    STOP_POLL_MS: 'the documented bound on how long disconnect waits on a backoff',
  };

  const consumers = (name: string): string[] =>
    importingFiles()
      .filter(({ code }) => new RegExp(`\\b${name}\\b`).test(code))
      .map(({ path }) => path);

  it('finds consumers at all, so the rows below are not reading an empty set', () => {
    expect(importingFiles().length).toBeGreaterThan(5);
    expect(consumers('fetchWithRetry').length).toBeGreaterThan(3);
    expect(Object.keys(api).length).toBeGreaterThan(5);
  });

  it.each(Object.keys(api).sort())('`%s` is imported somewhere, or kept on purpose', (name) => {
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

/**
 * A bound on elapsed time stated in terms of the figure that governs the wait discriminates nothing:
 * raise the figure and the bound rises with it, so the wait it promises to cap can grow without a
 * row going red. Keep every such bound an absolute figure, and pin the constant on its own terms.
 *
 * Graded over `test/**` rather than at the sites that have it today, so the next bound written
 * against `DEFAULT_BACKOFF_MS`, `DEFAULT_DEADLINE_MS` or a case's own `deadlineMs` lands red instead
 * of certifying whatever the figure becomes.
 */
describe('no elapsed-time bound is stated in terms of the figure it grades', () => {
  const ELAPSED_SUBJECT = /Date\.now\(\)\s*-|elapsed/i;
  const ORDER_MATCHERS = new Set([
    'toBeLessThan',
    'toBeLessThanOrEqual',
    'toBeGreaterThan',
    'toBeGreaterThanOrEqual',
  ]);

  /** The balanced argument opening at `open`, so a subject like `Date.now() - t` is read whole. */
  const argAt = (code: string, open: number): { text: string; end: number } => {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')' && --depth === 0) return { text: code.slice(open + 1, i), end: i };
    }
    return { text: '', end: code.length };
  };

  const elapsedBounds = (code: string): string[] => {
    const out: string[] = [];
    for (const at of code.matchAll(/\bexpect\(/g)) {
      const subject = argAt(code, (at.index as number) + 'expect'.length);
      if (!ELAPSED_SUBJECT.test(subject.text)) continue;
      const call = /^(?:\s*\.(?:not|resolves|rejects))*\s*\.(\w+)\(/.exec(code.slice(subject.end + 1));
      if (call === null || !ORDER_MATCHERS.has(call[1] as string)) continue;
      out.push(argAt(code, subject.end + call[0].length).text);
    }
    return out;
  };

  const namesIn = (expression: string): string[] =>
    [...expression.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*/g)].map((m) => m[0]);

  /**
   * A file's code, with comments and string literals removed. An assertion QUOTED in a string is
   * data — the reader's own self-test feeds it its subject matter that way — and a bound narrated
   * in a comment is prose.
   */
  const codeOf = (text: string): string =>
    text
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/^\s*\/\/.*$/gm, '')
      .replaceAll(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replaceAll(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replaceAll(/`(?:[^`\\]|\\.)*`/g, '``');

  /** Figures a bound may not name: what the package ships, and what a case hands the loop. */
  const exportedFigures = (): string[] =>
    Object.entries(api)
      .filter(([, value]) => typeof value === 'number')
      .map(([name]) => name);

  const budgetNames = (code: string): string[] =>
    [
      ...code.matchAll(/\b(?:deadlineMs|blockMs|timeoutMs|retryAfterMs):\s*([A-Za-z_$][\w$]*)/g),
    ].map((m) => m[1] as string);

  const testSources = (): [string, string][] =>
    readdirSync(new URL('../test/', import.meta.url), { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.ts'))
      .sort()
      .map((name) => [name, codeOf(readFileSync(new URL(`../test/${name}`, import.meta.url), 'utf8'))]);

  const graded = (): [string, string][] =>
    testSources().filter(([, code]) => elapsedBounds(code).length > 0);

  it('finds elapsed bounds and a vocabulary to grade them against', () => {
    expect(graded().flatMap(([, code]) => elapsedBounds(code)).length).toBeGreaterThan(4);
    expect(graded().length).toBeGreaterThan(2);
    expect(exportedFigures().length).toBeGreaterThan(4);
    expect(testSources().flatMap(([, code]) => budgetNames(code))).not.toEqual([]);
    // The forbidden vocabulary has to be within reach, or the rows below forbid nothing.
    const named = testSources().flatMap(([, code]) =>
      exportedFigures().filter((figure) => namesIn(code).includes(figure)),
    );
    expect(named).not.toEqual([]);
  });

  // The reader against the spellings it has to tell apart, so it cannot regress to finding nothing
  // — which would leave every row below grading an empty list.
  it.each([
    ['a captured elapsed local', 'expect(elapsed).toBeLessThan(stopAtMs + STOP_POLL_MS + 150);', ['stopAtMs', 'STOP_POLL_MS']],
    ['an inline clock read', 'expect(Date.now() - started).toBeLessThan(DEADLINE_MS);', ['DEADLINE_MS']],
    ['a field off a probe', 'expect(run.elapsedMs).toBeLessThanOrEqual(BUDGET);', ['BUDGET']],
    ['a floor', 'expect(elapsed).toBeGreaterThanOrEqual(FLOOR);', ['FLOOR']],
    ['a negated bound', 'expect(elapsed).not.toBeLessThan(FLOOR);', ['FLOOR']],
    ['a bound behind a message', "expect(elapsed, 'too slow').toBeLessThan(BUDGET);", ['BUDGET']],
    ['an absolute figure', 'expect(elapsed).toBeLessThan(2_000);', []],
    ['an assertion about something else', 'expect(state.calls).toBe(DEADLINE_MS);', []],
    ['a non-ordering matcher', 'expect(elapsed).toBe(DEADLINE_MS);', []],
  ])('reads %s', (_label, snippet, names) => {
    expect(elapsedBounds(snippet).flatMap(namesIn)).toEqual(names);
  });

  it.each(graded())('%s states its elapsed bounds in figures', (_path, code) => {
    const forbidden = new Set([...exportedFigures(), ...budgetNames(code)]);
    const offenders = elapsedBounds(code).filter((bound) =>
      namesIn(bound).some((name) => forbidden.has(name)),
    );
    expect(
      offenders,
      'an elapsed-time bound naming the figure that governs the wait it grades — widening the ' +
        'figure widens the bound with it, so the wait can grow without a row going red. State the ' +
        'bound as a figure, and pin the constant on its own terms beside it',
    ).toEqual([]);
  });
});
