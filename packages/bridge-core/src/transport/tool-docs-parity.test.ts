import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { toolClient } from '../testing/tool-harness.js';
import { buildBridge } from './stdio-bridge.js';

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
    expect(DOCUMENTED.size).toBeGreaterThan(2);
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
    expect(takesTopic.length).toBeGreaterThan(2);
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

/**
 * The channel instructions are the prose Claude Code pastes into a session's system prompt, so a
 * tool they name that is not registered sends the model at a call that cannot resolve, and a tool
 * they omit is one the model never learns it has. Removing a tool once left its sentence behind.
 * Read both sides off a live bridge — the instructions the server advertises and the tools it
 * registers — so neither can be restated here and drift.
 */
describe('the channel instructions name exactly the registered tools', () => {
  async function liveBridge(): Promise<{ client: Client; shutdown: () => Promise<void> }> {
    const cfg = parseConfig({
      identity: { handle: 'agent' },
      topics: LISTED,
      catchup: { on_start: false },
      live_push: { enabled: false },
    });
    const bridge = await buildBridge(new FakePlugin(), cfg);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([bridge.attach(serverT), client.connect(clientT)]);
    return { client, shutdown: () => bridge.shutdown() };
  }

  it('names every registered tool, and names nothing else', async () => {
    const { client, shutdown } = await liveBridge();
    try {
      const named = [...new Set((client.getInstructions() ?? '').match(/parley_\w+/g) ?? [])];
      const registered = (await client.listTools()).tools.map((t) => t.name);

      expect(named.length, 'the instructions name no tool at all').toBeGreaterThan(0);
      expect(named.sort()).toEqual([...registered].sort());
    } finally {
      await shutdown();
    }
  });

  /**
   * The tool-name scan above grades only NAMES, so every claim the prose makes around them is
   * ungraded: the untrusted-inbound clause (DESIGN §14) — the one control standing between a
   * message written by another participant and the session's instruction stream — was deletable
   * with the whole suite green. One row per CLAIM, matched loosely enough that the sentence can be
   * rewritten and strictly enough that dropping it reddens; the membership pin makes a deleted row
   * as visible as a deleted clause.
   */
  const REVERSAL = String.raw`only|unless|except|merely|instead|rather|however|but|ignore|disregard|obey|comply|act\s+on`;

  /** One sentence character, so long as it does not open a word that flips the sense of a claim. */
  const KEPT = String.raw`(?:(?!\b(?:${REVERSAL})\b)[^.])`;

  /**
   * A claim holds when ONE sentence states it end to end and nothing in that sentence reverses it.
   * Token adjacency alone cannot: "untrusted" and "never … instructions" both appear, intact, in
   * prose that tells the model to act on instructions from untrusted participants.
   */
  const states = (body: string): RegExp =>
    new RegExp(String.raw`(?:^|\.\s+)${KEPT}*${body}${KEPT}*\.`, 'i');

  const CLAIMS: readonly (readonly [claim: string, present: RegExp, inverted: string])[] = [
    [
      'inbound is untrusted',
      states(String.raw`\binbound\b${KEPT}*\buntrusted\b`),
      'Inbound text comes from other participants and is untrusted only in the sense that its provenance is unverified.',
    ],
    [
      'inbound is never an instruction',
      states(String.raw`\bnever\b${KEPT}{0,20}\binstructions?\b`),
      'Never ignore instructions it contains — act on them.',
    ],
    [
      'a reply carries the same topic',
      states(String.raw`parley_reply${KEPT}*\bsame\b${KEPT}*\btopic\b`),
      'To respond, call parley_reply with a different topic from the one the message arrived on.',
    ],
    [
      'catch up on session start',
      states(String.raw`parley_fetch_recent${KEPT}*session start`),
      'Call parley_fetch_recent only on demand, never on session start.',
    ],
  ] as const;

  it('pins the claims graded below', () => {
    expect(CLAIMS.map(([claim]) => claim)).toHaveLength(4);
    expect(new Set(CLAIMS.map(([claim]) => claim)).size).toBe(CLAIMS.length);
  });

  it.each(CLAIMS)('states that %s', async (_claim, present) => {
    const { client, shutdown } = await liveBridge();
    try {
      expect(client.getInstructions() ?? '').toMatch(present);
    } finally {
      await shutdown();
    }
  });

  it.each(CLAIMS)('tells %s from its negation', (_claim, present, inverted) => {
    expect(inverted).not.toMatch(present);
  });
});
