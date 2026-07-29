import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';

// Class: a public claim must be mechanically tied to the code. README/npm text drifts silently —
// a reader who believes the wrong claim builds on semantics the plugin does not have — so the
// documented names are recomputed here and the retired claims are asserted gone.
const read = (p: string): string =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const readme = read('../README.md');
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

  const configKeys = ['token', 'user', 'pass', 'creds_file', 'nkey_seed', 'tls', 'retention_days'];
  for (const key of configKeys) {
    it(`README documents the \`${key}\` backend_config field`, () => {
      expect(readme).toContain(key);
    });
  }
});
