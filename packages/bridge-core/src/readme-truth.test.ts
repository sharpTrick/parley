import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { allowlistFor, TopicNotAllowedError } from './allowlist.js';
import { parseConfig } from './config.js';
import { MAX_TOPIC_LEN } from './engine/presence-beat.js';
import { MAX_MATCH_INPUT } from './regex-safety.js';

// This package's README IS its API doc — it is what an operator reads before writing a config, and
// the only place several capabilities are described in prose at all. Three backend packages ship a
// readme-truth suite; core, whose README makes the most promises, shipped none, and a promise no
// test executes drifts silently: `post_topics` was documented as widening post/fetch to "any
// fully-matching topic" while `Allowlist.has` refused every match longer than MAX_MATCH_INPUT, a
// region an ordinary config reaches because the loader accepts topics up to MAX_TOPIC_LEN.
//
// So: EXECUTE the README's own sample rather than transcribing it, derive the probe values from the
// constants rather than from the prose, and require the prose to state whatever verdict the code
// gives. Every scan below carries a floor, so a reworded README fails loudly instead of quietly
// grading nothing.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** The README's own config sample, as a yaml block — the one an operator copies. */
function documentedConfigSamples(): string[] {
  return [...README.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((m) => m[1]!)
    .filter((body) => body.includes('post_topics:'));
}

/** Every shipped source file, so a claim scan cannot be scoped to the file it was written about. */
function sourceFiles(dir = HERE): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return sourceFiles(`${dir}${e.name}/`);
    if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) return [];
    return [`${dir}${e.name}`];
  });
}

/** Wherever the ceiling is stated in prose, with the number it states. */
const CEILING_CLAIM = /topics of at most (\d+) characters/g;

/** Join wrapped prose so a claim keeps matching when a doc comment is re-flowed around it. */
const unwrapped = (text: string): string => text.replace(/\n[ \t]*(?:\*|#)?[ \t]*/g, ' ');

const claimedCeilings = (text: string): number[] =>
  [...unwrapped(text).matchAll(CEILING_CLAIM)].map((m) => Number(m[1]));

describe("the README's config sample is executed, not transcribed", () => {
  it('ships exactly one sample carrying post_topics', () => {
    expect(documentedConfigSamples()).toHaveLength(1);
  });

  it('loads through parseConfig as written', () => {
    const cfg = parseConfig(parseYaml(documentedConfigSamples()[0]!));
    expect(cfg.topics.length).toBeGreaterThan(0);
    expect(cfg.post_topics.length).toBeGreaterThan(0);
  });
});

const sampleConfig = (): ReturnType<typeof parseConfig> =>
  parseConfig(parseYaml(documentedConfigSamples()[0]!));

/** The literal head of the README's own pattern, so the probes match the example it publishes. */
function documentedPatternPrefix(): string {
  const source = sampleConfig().post_topics[0]!;
  const prefix = /^[A-Za-z0-9_-]+/.exec(source)?.[0];
  expect(prefix, `no literal prefix in the README's post_topics example ${source}`).toBeTruthy();
  return prefix!;
}

const LENGTHS = [
  { label: 'a short topic', len: 8 },
  { label: 'one below the clamp', len: MAX_MATCH_INPUT - 1 },
  { label: 'exactly the clamp', len: MAX_MATCH_INPUT },
  { label: 'one past the clamp', len: MAX_MATCH_INPUT + 1 },
  { label: 'the longest topic the loader accepts', len: MAX_TOPIC_LEN },
] as const;

describe("the README's `post_topics` widening is true at every length it is reachable at", () => {
  it.each(LENGTHS.map((l) => [l.label, l.len] as const))(
    'says what the code does for %s (%i chars)',
    (_label, len) => {
      const cfg = sampleConfig();
      const prefix = documentedPatternPrefix();
      const topic = prefix + 'a'.repeat(len - prefix.length);
      expect(topic).toHaveLength(len);
      expect(
        new RegExp(`^(?:${cfg.post_topics[0]!})$`).test(topic),
        'probe must fully match the pattern, or it grades nothing',
      ).toBe(true);

      const allowed = allowlistFor(cfg).has(topic);
      expect(allowed).toBe(len <= MAX_MATCH_INPUT);
      if (allowed) return;

      expect(() => allowlistFor(cfg).assert(topic)).toThrow(TopicNotAllowedError);
      expect(claimedCeilings(README), 'the README does not state the ceiling it enforces').toContain(
        MAX_MATCH_INPUT,
      );
    },
  );

  it("the README's own escape hatch reaches what the pattern cannot", () => {
    const prefix = documentedPatternPrefix();
    const topic = prefix + 'a'.repeat(MAX_TOPIC_LEN - prefix.length);
    const cfg = parseConfig({ identity: { handle: 'h' }, topics: [topic] });
    expect(allowlistFor(cfg).has(topic)).toBe(true);
  });
});

describe('the ceiling is stated wherever the widening is promised', () => {
  it('states the enforced number and no other, everywhere it is stated', () => {
    const surfaces = [README, ...sourceFiles().map((f) => readFileSync(f, 'utf8'))];
    const stated = surfaces.flatMap(claimedCeilings);
    expect(
      stated.length,
      'the ceiling claim matched fewer surfaces than it was written against — reworded, or gone',
    ).toBeGreaterThanOrEqual(6);
    for (const n of stated) expect(n).toBe(MAX_MATCH_INPUT);
  });

  it('states it on the operator-facing page, at the sample and at the Allowlist rule', () => {
    expect(claimedCeilings(README).length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * CLASS: a ROOT document stating a config key's contract differently from the validator that
 * decides it. The operator-facing page above is executed rather than transcribed; the documents a
 * contributor is pointed at FIRST were not read by anything, and two of them described a key this
 * loader refuses as a working, sandbox-gated knob — an argument for implementing the leniency the
 * loader exists to refuse. A third wrote a value the loader rejects into the one complete config
 * example in the repo, so the block a reader copies did not load.
 *
 * Both halves are derived: the documents come from the repository root rather than a list kept
 * here, and which keys are graded comes from asking THIS loader which values it refuses.
 */
const REPO_ROOT = new URL('../../../', import.meta.url);

/** Every document at the repository root — the set, so a document added later is graded too. */
function rootDocuments(): { name: string; text: string }[] {
  return readdirSync(REPO_ROOT)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({ name, text: readFileSync(new URL(name, REPO_ROOT), 'utf8') }));
}

/** A yaml block naming `identity:` is a whole Parley config, not a fragment of one. */
const configBlocksIn = (text: string): string[] =>
  [...text.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((m) => m[1]!)
    .filter((body) => /^identity:/m.test(body));

interface DocConfig {
  doc: string;
  parsed: Record<string, unknown>;
}

function documentedConfigs(): DocConfig[] {
  return rootDocuments().flatMap(({ name, text }) =>
    configBlocksIn(text).map((yaml) => ({
      doc: name,
      parsed: parseYaml(yaml) as Record<string, unknown>,
    })),
  );
}

/** Every `a.b` path in `config` whose leaf is a boolean — the knobs a document can call a default. */
function booleanPaths(config: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(config).flatMap(([key, value]) => {
    if (typeof value === 'boolean') return [`${prefix}${key}`];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return booleanPaths(value as Record<string, unknown>, `${prefix}${key}.`);
    }
    return [];
  });
}

const withPathSet = (
  config: Record<string, unknown>,
  path: string,
  value: boolean,
): Record<string, unknown> => {
  const copy = structuredClone(config);
  const segments = path.split('.');
  let at = copy;
  for (const segment of segments.slice(0, -1)) at = at[segment] as Record<string, unknown>;
  at[segments.at(-1) as string] = value;
  return copy;
};

/**
 * Why the loader refuses `path: value` AT THAT PATH, or undefined otherwise. Keep the issue's own
 * path the test, so that a key refused because a DIFFERENT key was set with it — a relational rule,
 * which every one of these documents may legitimately call a knob — is not read as an unimplemented
 * one.
 */
function refusalFor(
  config: Record<string, unknown>,
  path: string,
  value: boolean,
): string | undefined {
  try {
    parseConfig(withPathSet(config, path, value));
    return undefined;
  } catch (err) {
    const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
    return issues?.find((issue) => issue.path.join('.') === path)?.message;
  }
}

/**
 * A key the loader refuses AS UNIMPLEMENTED is not a knob, whatever a document calls it. Derived by
 * asking the loader, so the next key that lands unimplemented is graded the day it does; the floor
 * below is what fails if the loader rewords its refusal out from under this reading.
 */
function unsettableKeys(config: Record<string, unknown>): { path: string; refusal: string }[] {
  return booleanPaths(config).flatMap((path) => {
    const refusal = refusalFor(config, path, true) ?? refusalFor(config, path, false);
    return refusal !== undefined && REFUSAL_LANGUAGE.test(refusal) ? [{ path, refusal }] : [];
  });
}

/** How a document describes something an operator may choose. */
const KNOB_LANGUAGE = /defaults? (?:off|on)\b|sandbox[- ]only|opt[- ]in|turn(?:ed)? (?:it )?on/i;
/** How this loader's own refusal reads, and so how a document must read where it names the key. */
const REFUSAL_LANGUAGE = /not implemented|load error/i;

/** Every passage of `text` naming `key`, each with the line before and after it for context. */
function passagesNaming(text: string, key: string): string[] {
  const lines = text.split('\n');
  return lines.flatMap((line, i) =>
    line.includes(key) ? [lines.slice(Math.max(0, i - 1), i + 2).join(' ')] : [],
  );
}

export function knobLanguageFindings(
  docs: readonly { name: string; text: string }[],
  key: string,
): string[] {
  return docs.flatMap(({ name, text }) =>
    passagesNaming(text, key)
      .filter((passage) => KNOB_LANGUAGE.test(passage) && !REFUSAL_LANGUAGE.test(passage))
      .map((passage) => `${name}: ${passage.trim()}`),
  );
}

describe('every root document agrees with the loader that decides the config', () => {
  it('finds the documents and a whole config inside them, so the rows below are not empty', () => {
    expect(rootDocuments().length, 'no root document found at all').toBeGreaterThanOrEqual(4);
    expect(
      documentedConfigs().length,
      'no root document carries a complete config example any more',
    ).toBeGreaterThanOrEqual(1);
  });

  it.each(documentedConfigs().map((c) => [`${c.doc} config example`, c] as const))(
    '%s loads',
    (_label, config) => {
      expect(() => parseConfig(config.parsed)).not.toThrow();
    },
  );

  it('finds a key the loader refuses as unimplemented, so the rows below grade something', () => {
    expect(
      documentedConfigs().flatMap((c) => unsettableKeys(c.parsed)).length,
      'no documented key is refused as unimplemented — reworded, or gone',
    ).toBeGreaterThanOrEqual(1);
  });

  it('never calls a key the loader refuses a knob, and says somewhere that it is refused', () => {
    const docs = rootDocuments();
    const unsettable = documentedConfigs().flatMap((c) => unsettableKeys(c.parsed));
    for (const { path } of unsettable) {
      const key = path.split('.').at(-1) as string;
      expect(
        knobLanguageFindings(docs, key),
        `a root document describes '${key}' as a knob, and this loader refuses it`,
      ).toEqual([]);
      expect(
        docs.filter(({ text }) =>
          passagesNaming(text, key).some((p) => REFUSAL_LANGUAGE.test(p)),
        ).length,
        `no root document states that '${key}' is refused`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('reads knob language, and reads a passage that states the refusal beside it (controls)', () => {
    const planted = [
      { name: 'PLANTED.md', text: '- **`k` defaults OFF**, sandbox-only.\n' },
      { name: 'FIXED.md', text: '- `k` is not implemented; `true` is a load error.\n' },
      { name: 'BOTH.md', text: '- `k` is not implemented, so there is no sandbox-only mode.\n' },
      { name: 'QUIET.md', text: '- `k` is passed to the plugin verbatim.\n' },
    ];
    expect(knobLanguageFindings(planted, 'k')).toEqual([
      'PLANTED.md: - **`k` defaults OFF**, sandbox-only.',
    ]);
    expect(knobLanguageFindings(planted, 'absent')).toEqual([]);
  });
});
