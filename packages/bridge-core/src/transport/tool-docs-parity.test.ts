import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it } from 'vitest';
import { toolClient } from '../testing/tool-harness.js';

/**
 * The package README's tool table is the surface an operator reads before wiring an agent, and it
 * had drifted: a whole shipped tool missing, a parameter missing, and an allowlist sentence that
 * `post_topics` had made false. Derive the comparison from `registerTools` and from the table's own
 * markdown rather than restating either, so a tool or a parameter added on one side fails until the
 * other moves — and pin the allowlist SENTENCE behaviourally, since prose about who is refused is
 * the part an operator relies on for security.
 */
const LISTED = ['ctx'];
const PATTERN = 'ops-.*';
const WIDENED = 'ops-eu'; // matches `post_topics`, listed in neither `topics` nor the enum
const STRANGER = 'not-mine';

async function harness(): Promise<Client> {
  return (await toolClient({ topics: LISTED, postPatterns: [PATTERN] })).client;
}

/** Every `| \`parley_x\` | role | effect |` row, mapped to the input names its first `{…}` span lists. */
function documentedTools(): Map<string, string[]> {
  const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');
  const out = new Map<string, string[]>();
  for (const [, tool, effect] of readme.matchAll(/^\|\s*`(parley_\w+)`\s*\|[^|]*\|\s*(.*?)\s*\|\s*$/gm)) {
    const params = /`\{([^}]*)\}`/.exec(effect!)?.[1] ?? '';
    out.set(
      tool!,
      params.split(',').map((p) => p.trim().replace(/\?$/, '')).filter((p) => p.length > 0),
    );
  }
  return out;
}

const DOCUMENTED = documentedTools();

interface ListedTool {
  name: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[] };
}

describe('the README tool table matches the registered surface', () => {
  it('parses the table (guards against a broken scan)', () => {
    expect(DOCUMENTED.size).toBeGreaterThan(3);
    expect(DOCUMENTED.get('parley_post')).toEqual(['topic', 'content', 'in_reply_to']);
  });

  it('documents exactly the tools registerTools registers', async () => {
    const { tools } = await (await harness()).listTools();
    expect([...DOCUMENTED.keys()].sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it.each([...DOCUMENTED.keys()])('documents every input %s accepts', async (name) => {
    const { tools } = await (await harness()).listTools();
    const tool = tools.find((t) => t.name === name) as ListedTool | undefined;
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(
      [...DOCUMENTED.get(name)!].sort(),
    );
  });
});

/**
 * The table's allowlist paragraph is a security claim — an operator who reads `post_topics` as
 * subscribe-only reach leaves a wider write surface than they think. Grade it against every tool
 * the table says is gated, deriving the argument bag from the registered schema so a new required
 * field cannot quietly turn a row into a validation error that reads like a refusal.
 */
describe('a post_topics-matched topic is accepted by every allowlist-gated tool', () => {
  const takesTopic = [...DOCUMENTED].filter(([, p]) => p.includes('topic')).map(([name]) => name);

  it('finds allowlist-gated tools to check (guards against a broken filter)', () => {
    expect(takesTopic.length).toBeGreaterThan(3);
  });

  it.each(takesTopic)('%s', async (name) => {
    const client = await harness();
    const { tools } = await client.listTools();
    const schema = (tools.find((t) => t.name === name) as ListedTool).inputSchema;
    const argsFor = (topic: string): Record<string, unknown> =>
      Object.fromEntries([
        ['topic', topic],
        ...(schema.required ?? []).filter((r) => r !== 'topic').map((r) => [r, 'x']),
      ]);

    const widened = await client.callTool({ name, arguments: argsFor(WIDENED) });
    expect(widened.isError ?? false, JSON.stringify(widened.content)).toBe(false);

    const stranger = await client.callTool({ name, arguments: argsFor(STRANGER) });
    expect(stranger.isError).toBe(true);
    expect(JSON.stringify(stranger.content)).toContain('topic not allowed');
  });
});
