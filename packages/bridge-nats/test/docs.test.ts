import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';

// Class: a public claim must be mechanically tied to the code. README/npm text drifts silently —
// a reader who believes the wrong claim builds on semantics the plugin does not have — so the
// documented names are recomputed here and the retired claims are asserted gone.
// The sharpest form of the drift is a claim asserting a PROPERTY the code spends its length
// defending against the absence of: the package shipped "contiguous" to npm while its own window
// tests tabled six sparse streams and the reader who sized a page as `last_seq - since` paid for
// it. Those words are banned across every public surface — README, the npm description, and the
// source JSDoc that becomes the published types.
const read = (p: string): string =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const readme = read('../README.md');
const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ name: f, text: readFileSync(join(srcDir, f), 'utf8') }));
const manifest = JSON.parse(read('../package.json')) as { description: string; keywords: string[] };

const names = (topic: Topic): { subject: string; stream: string } => {
  const plugin = new NatsPlugin() as unknown as {
    subject: (t: Topic) => string;
    streamName: (t: Topic) => string;
  };
  return { subject: plugin.subject(topic), stream: plugin.streamName(topic) };
};

// Exactly the rows of the README's "Topic → subject / stream names" table.
const documented = [
  { topic: 'deploys', subject: 'parley.deploys', stream: 'PARLEY_deploys' },
  { topic: 'team.chat', subject: 'parley.team_chat-<sha1-10>', stream: 'PARLEY_team_chat-<sha1-10>' },
  { topic: 'ops/oncall', subject: 'parley.ops/oncall', stream: 'PARLEY_ops_oncall-<sha1-10>' },
  { topic: 'red team', subject: 'parley.red_team-<sha1-10>', stream: 'PARLEY_red_team-<sha1-10>' },
];

const asPattern = (documentedName: string): RegExp =>
  new RegExp(
    `^${documentedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('<sha1-10>', '[0-9a-f]{10}')}$`,
  );

describe('nats docs conformance', () => {
  for (const row of documented) {
    it(`README documents the real subject/stream names for \`${row.topic}\``, () => {
      expect(readme).toContain(`| \`${row.topic}\` | \`${row.subject}\` | \`${row.stream}\` |`);
      const actual = names(asTopic(row.topic));
      expect(actual.subject).toMatch(asPattern(row.subject));
      expect(actual.stream).toMatch(asPattern(row.stream));
    });
  }

  // The live consumer is a plain named ephemeral one plus an explicit rebuild watcher; calling it
  // "ordered" promises nats.js OrderedConsumer semantics (automatic gap detection and reset).
  const retired = ['ordered consumer', 'DeliverPolicy.New'];
  for (const claim of retired) {
    it(`neither the README nor the npm description claims "${claim}"`, () => {
      expect(readme.toLowerCase()).not.toContain(claim.toLowerCase());
      expect(manifest.description.toLowerCase()).not.toContain(claim.toLowerCase());
    });
  }

  // Properties the code explicitly handles the ABSENCE of. Claiming one is worse than saying
  // nothing: it invites the reader to compute a count from `last_seq - since`, or to treat the
  // sequence as an id that never repeats across a re-provisioned stream.
  const bannedProperties = ['contiguous', 'dense', 'gapless', 'unbroken', 'consecutive'];
  const surfaces = [
    { name: 'README.md', text: readme },
    { name: 'the npm description', text: manifest.description },
    ...sources.map((f) => ({ name: `src/${f.name}`, text: f.text })),
  ];
  /** Occurrences of `word` that ASSERT it — a negated mention is the text doing its job. */
  const assertions = (text: string, word: string): string[] => {
    const found: string[] = [];
    for (const m of text.matchAll(new RegExp(`\\b${word}\\b`, 'gi'))) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 30), m.index);
      if (!/\b(not|never|non)\b[\s*_-]*$/i.test(before)) {
        found.push(text.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + word.length));
      }
    }
    return found;
  };

  for (const surface of surfaces) {
    for (const claim of bannedProperties) {
      it(`${surface.name} does not claim the sequence is "${claim}"`, () => {
        expect(assertions(surface.text, claim)).toEqual([]);
      });
    }
  }

  it('the banned-claim check reads a claim and spares its negation', () => {
    expect(assertions('the range is dense', 'dense')).toHaveLength(1);
    expect(assertions('the range is **not** dense', 'dense')).toEqual([]);
    expect(assertions('sequences are never contiguous', 'contiguous')).toEqual([]);
  });

  it('README documents the backendMsgId shape the code actually mints', () => {
    const plugin = new NatsPlugin() as unknown as {
      incarnations: Map<string, string>;
      streamName: (t: Topic) => string;
      msgId: (t: Topic, seq: number) => string;
    };
    const topic = asTopic('deploys');
    plugin.incarnations.set(plugin.streamName(topic), '20260101T000000Z');
    expect(plugin.msgId(topic, 42)).toBe('20260101T000000Z-42');
    expect(readme).toContain('`<stream incarnation>-<sequence>`');
  });

  const configKeys = ['token', 'user', 'pass', 'creds_file', 'nkey_seed', 'tls', 'retention_days'];
  for (const key of configKeys) {
    it(`README documents the \`${key}\` backend_config field`, () => {
      expect(readme).toContain(key);
    });
  }
});
