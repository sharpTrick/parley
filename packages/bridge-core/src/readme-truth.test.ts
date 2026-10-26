import { readdirSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { allowlistFor, TopicNotAllowedError } from './allowlist.js';
import { MAX_TOPIC_LEN, parseConfig } from './config.js';
import { MAX_MATCH_INPUT } from './regex-safety.js';

// A config example a reader copies must LOAD, and the widening it advertises must hold at every
// length an ordinary config can reach. So the samples here are executed through `parseConfig` and
// `allowlistFor` rather than transcribed, and the probe lengths come from `MAX_MATCH_INPUT` and
// `MAX_TOPIC_LEN` rather than from the prose.
//
// Proof it can fail: widen `Allowlist.has` past `MAX_MATCH_INPUT`, or narrow `MAX_TOPIC_LEN` below
// the README's own `post_topics` example, and the length rows red.

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** The README's own config sample, as a yaml block — the one an operator copies. */
function documentedConfigSamples(): string[] {
  return [...README.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((m) => m[1]!)
    .filter((body) => body.includes('post_topics:'));
}

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
    },
  );

  it("the README's own escape hatch reaches what the pattern cannot", () => {
    const prefix = documentedPatternPrefix();
    const topic = prefix + 'a'.repeat(MAX_TOPIC_LEN - prefix.length);
    const cfg = parseConfig({ identity: { handle: 'h' }, topics: [topic] });
    expect(allowlistFor(cfg).has(topic)).toBe(true);
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
});
