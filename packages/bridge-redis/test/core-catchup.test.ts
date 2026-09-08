import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Allowlist,
  asCursor,
  asHandle,
  catchUpTopic,
  ReadStateStore,
  registerTools,
  SeenSet,
  type ToolDeps,
  type Topic,
} from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import type { RedisPlugin } from '../src/index.js';
import { freshTopic as mintTopic, isRedisUp, REDIS_URL, withPlugin } from './support.js';

// CLASS: a plugin comment or README asserts a behaviour that lives in another package. This plugin
// throws on a cursor it did not mint and heals one that merely sorts past the stream's tail; what
// CORE does with each is a fact about core's catch-up driver, not about this plugin, so it is pinned
// here against the real `catchUpTopic` instead of described in a comment that cannot rot visibly.

const redisUp = await isRedisUp(REDIS_URL);

const freshTopic = (): Topic => mintTopic('catchup');

interface Rig {
  plugin: RedisPlugin;
  topic: Topic;
  readState: ReadStateStore;
  drain: () => Promise<number>;
  /** One `parley_fetch_recent`, as the agent makes it — core writes the position, not this file. */
  agentReads: () => Promise<void>;
}

/**
 * The registered `parley_fetch_recent` handler over a plugin. Driven rather than emulated, so that
 * the read position a case sets up is written by CORE's rule — which caps an oversized page,
 * re-derives the cursor from the last row kept, and refuses to move a position the read did not
 * resume from. A test that reproduces that rule by hand reproduces a DIFFERENT one, and then grades
 * a value it wrote itself two lines earlier.
 */
function agentFetch(deps: ToolDeps): () => Promise<void> {
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const collector = {
    registerTool: (name: string, _cfg: unknown, h: (args: Record<string, unknown>) => Promise<unknown>) => {
      if (name === 'parley_fetch_recent') handler = h;
    },
  };
  registerTools(collector as unknown as Parameters<typeof registerTools>[0], deps);
  return async () => {
    await handler!({ topic: String(deps.allow.topics()[0]) });
  };
}

/** A connected plugin whose topic core has already read up to `storedCursor`, ready to catch up. */
function withRig(storedCursor: string, body: (rig: Rig) => Promise<void>): Promise<void> {
  return withPlugin({}, async ({ plugin }) => {
    const topic = freshTopic();
    const readState = new ReadStateStore(
      join(mkdtempSync(join(tmpdir(), 'parley-redis-catchup-')), 'read-state.json'),
    );
    readState.set(topic, asCursor(storedCursor));
    const seen = new SeenSet();
    await body({
      plugin,
      topic,
      readState,
      drain: () => catchUpTopic({ plugin, topic, limit: 100, readState, seen }),
      agentReads: agentFetch({
        plugin,
        identity: asHandle('reader'),
        allow: new Allowlist([String(topic)]),
        seen,
        readState,
        blockMaxMs: 60_000,
        blockPollIntervalMs: 20,
      }),
    });
  });
}

describe.skipIf(!redisUp)('redis + core catch-up — what core actually does with each cursor', () => {
  // A foreign cursor is FATAL for the topic: core rethrows anything that is not a NoSuchTopicError
  // and annotates the first resumed page with the read-state path. Nothing is dropped and no window
  // is refetched, so a plugin comment promising core recovers sends a maintainer the wrong way.
  const foreign = [
    ['a matrix-style sync token', 's123_456'],
    ['an xmpp archive id', '2f9a-77bd-4c11'],
    ['a plain word', 'abc'],
  ] as const;

  it.each(foreign)('aborts catch-up on %s, naming the plugin and the state file', async (_l, c) =>
    withRig(c, async (r) => {
      await r.plugin.post(r.topic, asHandle('w'), 'one');
      const failure = await r.drain().then(
        () => undefined,
        (err: Error) => err,
      );
      expect(failure, 'core swallowed a cursor this backend cannot parse').toBeInstanceOf(Error);
      expect(failure?.message).toContain('catch-up failed on topic');
      expect(failure?.message).toContain('parley-redis: malformed cursor');
      expect(failure?.message).toContain(r.readState.path);
      // The read position was NOT advanced, so a restart hits the same wall until an operator acts.
      expect(r.readState.get(r.topic)).toBe(c);
    }));

  // The deliberate asymmetry: a cursor that is well-formed but sorts past the stream's last generated
  // id IS recovered — by this plugin, silently, with core never seeing an error at all.
  it('drains the whole window for a cursor past the high-water mark', async () => {
    const future = `${Date.now() + 86_400_000}-0`;
    await withRig(future, async (r) => {
      await r.plugin.post(r.topic, asHandle('w'), 'one');
      await r.plugin.post(r.topic, asHandle('w'), 'two');
      await expect(r.drain()).resolves.toBe(2);
      // The driver reads the window without moving the position — `parley_fetch_recent` is what
      // advances it, once the agent has actually been handed the page — so the agent's read is
      // what makes the next catch-up incremental.
      await r.agentReads();
      expect(
        r.readState.get(r.topic),
        'the tool left the position on a cursor past the stream\'s tail, so every later ' +
          'since-less read opens past everything the topic holds',
      ).not.toBe(future);
      // …and the advanced cursor is live: a second catch-up drains only what arrived since.
      await r.plugin.post(r.topic, asHandle('w'), 'three');
      await expect(r.drain()).resolves.toBe(1);
    });
  });

  it('drains only what is newer than a cursor this backend minted', async () =>
    withRig('0-1', async (r) => {
      await r.plugin.post(r.topic, asHandle('w'), 'one');
      await expect(r.drain()).resolves.toBe(1);
      await r.agentReads();
      await expect(r.drain()).resolves.toBe(0);
    }));
});
