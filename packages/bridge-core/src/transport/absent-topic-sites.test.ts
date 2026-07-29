import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { catchUpAll, catchUpTopic } from '../engine/catchup.js';
import { DEFAULT_PRESENCE_TOPIC } from '../engine/presence.js';
import type { ReadStateStore } from '../engine/read-state.js';
import { SeenSet } from '../engine/seen-set.js';
import { asHandle, asTopic } from '../message.js';
import { NoSuchTopicError, type BackendPlugin } from '../seam.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { memoryReadState } from '../testing/nonconformant.js';
import { startPushLoop } from './push-loop.js';
import { registerTools } from './tools.js';

/**
 * Every plugin depends on `@sharptrick/parley-core` as an ordinary dependency, so two installs in
 * one tree is a normal outcome — and then the absence sentinel a plugin throws is an instance of the
 * OTHER copy's class. Recognition therefore has to be by contract, at EVERY site: one site left on
 * `instanceof` reads "this chat channel does not exist yet" as a hard backend failure and bricks the
 * whole bridge on startup.
 *
 * Table the sites against the errors they must tell apart, and pin that no production site in core
 * has drifted back to `instanceof`.
 */
const T = asTopic('ctx');

/** A second install of this package: identical contract, a different class object. */
class ForeignAbsence extends Error {
  constructor(readonly topic: string) {
    super(`no such topic: ${JSON.stringify(topic)}`);
    this.name = 'NoSuchTopicError';
  }
}

type Outcome = 'degraded' | 'propagated';

const ERRORS = {
  'the native sentinel': (): never => {
    throw new NoSuchTopicError('ctx');
  },
  'a foreign twin from a duplicate install': (): never => {
    throw new ForeignAbsence('ctx');
  },
  'a generic backend failure': (): never => {
    throw new Error('backend on fire');
  },
} as const;

const EXPECTED: Record<keyof typeof ERRORS, Outcome> = {
  'the native sentinel': 'degraded',
  'a foreign twin from a duplicate install': 'degraded',
  'a generic backend failure': 'propagated',
};

/** A plugin whose named seam method fails; everything else behaves. */
function failingOn(method: 'fetchRecent' | 'subscribe', fail: () => never): BackendPlugin {
  const plugin = new FakePlugin();
  plugin[method] = async (): Promise<never> => fail();
  return plugin;
}

async function settled(work: Promise<unknown>): Promise<Outcome> {
  return work.then(
    () => 'degraded' as Outcome,
    () => 'propagated' as Outcome,
  );
}

/** A reactive tool client over a plugin whose `fetchRecent` fails. */
async function toolClient(fail: () => never): Promise<Client> {
  const server = new McpServer({ name: 'parley', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerTools(server, {
    plugin: failingOn('fetchRecent', fail),
    identity: asHandle('alice'),
    allow: new Allowlist(['ctx'], { reserved: [DEFAULT_PRESENCE_TOPIC] }),
    presenceTopic: asTopic(DEFAULT_PRESENCE_TOPIC),
    presenceTtlMs: 90_000,
    blockMaxMs: 60_000,
    blockPollIntervalMs: 20,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

async function toolOutcome(tool: string, args: Record<string, unknown>, fail: () => never): Promise<Outcome> {
  const client = await toolClient(fail);
  const res = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean };
  return res.isError === true ? 'propagated' : 'degraded';
}

const SITES: Array<[name: string, run: (fail: () => never) => Promise<Outcome>]> = [
  [
    'catchUpTopic',
    (fail) =>
      settled(
        catchUpTopic({
          plugin: failingOn('fetchRecent', fail),
          topic: T,
          limit: 10,
          readState: memoryReadState() as unknown as ReadStateStore,
          seen: new SeenSet(),
        }),
      ),
  ],
  [
    'catchUpTopic resuming from a stored cursor',
    (fail) => {
      const readState = memoryReadState();
      readState.set(T, '7' as never);
      return settled(
        catchUpTopic({
          plugin: failingOn('fetchRecent', fail),
          topic: T,
          limit: 10,
          readState: readState as unknown as ReadStateStore,
          seen: new SeenSet(),
        }),
      );
    },
  ],
  [
    'catchUpAll',
    (fail) =>
      settled(
        catchUpAll({
          plugin: failingOn('fetchRecent', fail),
          topics: [T, asTopic('ops')],
          limit: 10,
          readState: memoryReadState() as unknown as ReadStateStore,
          seen: new SeenSet(),
        }),
      ),
  ],
  [
    'startPushLoop',
    (fail) =>
      settled(
        startPushLoop(
          { server: { notification: async (): Promise<void> => {} } } as unknown as McpServer,
          failingOn('subscribe', fail),
          new Allowlist(['ctx']),
          new SeenSet(),
          { mentionFilter: false, identity: asHandle('alice') },
        ),
      ),
  ],
  ['parley_fetch_recent', (fail) => toolOutcome('parley_fetch_recent', { topic: 'ctx' }, fail)],
  [
    'parley_fetch_recent (long-poll)',
    (fail) => toolOutcome('parley_fetch_recent', { topic: 'ctx', since: '1', block_ms: 200 }, fail),
  ],
  ['parley_list_users', (fail) => toolOutcome('parley_list_users', {}, fail)],
];

describe('every absent-topic site recognises the sentinel by contract, not by class identity', () => {
  it('the foreign twin really is foreign (otherwise every row below proves nothing)', () => {
    expect(new ForeignAbsence('ctx') instanceof NoSuchTopicError).toBe(false);
  });

  for (const [site, run] of SITES) {
    it.each(Object.keys(ERRORS) as Array<keyof typeof ERRORS>)(`${site} × %s`, async (kind) => {
      expect(await run(ERRORS[kind])).toBe(EXPECTED[kind]);
    });
  }
});

describe('no production site in bridge-core recognises the sentinel by class identity', () => {
  const SRC = new URL('..', import.meta.url).pathname;

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sources(full);
      return full.endsWith('.ts') && !full.includes('.test.') ? [full] : [];
    });
  }

  it('only no-such-topic.ts, which is the helper itself', () => {
    const offenders = sources(SRC).filter((f) =>
      /instanceof\s+NoSuchTopicError/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => f.slice(SRC.length))).toEqual(['no-such-topic.ts']);
  });
});
