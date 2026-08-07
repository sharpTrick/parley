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
