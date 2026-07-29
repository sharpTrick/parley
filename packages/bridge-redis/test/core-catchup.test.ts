import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asCursor,
  asHandle,
  catchUpTopic,
  ReadStateStore,
  SeenSet,
  type Topic,
} from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { RedisPlugin } from '../src/index.js';
import { freshPrefix, freshTopic as mintTopic, isRedisUp, REDIS_URL, wipe } from './support.js';

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
  cleanup: () => Promise<void>;
}

async function rig(storedCursor: string): Promise<Rig> {
  const prefix = freshPrefix();
  const plugin = new RedisPlugin();
  await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
  const topic = freshTopic();
  const readState = new ReadStateStore(
    join(mkdtempSync(join(tmpdir(), 'parley-redis-catchup-')), 'read-state.json'),
  );
  readState.set(topic, asCursor(storedCursor));
  const seen = new SeenSet();
  return {
    plugin,
    topic,
    readState,
    drain: () => catchUpTopic({ plugin, topic, limit: 100, readState, seen }),
    cleanup: async () => {
      await plugin.disconnect().catch(() => undefined);
      await wipe(prefix);
    },
  };
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

  it.each(foreign)('aborts catch-up on %s, naming the plugin and the state file', async (_l, c) => {
    const r = await rig(c);
    try {
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
    } finally {
      await r.cleanup();
    }
  });

  // The deliberate asymmetry: a cursor that is well-formed but sorts past the stream's last generated
  // id IS recovered — by this plugin, silently, with core never seeing an error at all.
  it('drains the whole window for a cursor past the high-water mark', async () => {
    const future = `${Date.now() + 86_400_000}-0`;
    const r = await rig(future);
    try {
      await r.plugin.post(r.topic, asHandle('w'), 'one');
      await r.plugin.post(r.topic, asHandle('w'), 'two');
      await expect(r.drain()).resolves.toBe(2);
      expect(r.readState.get(r.topic)).not.toBe(future);
      // …and the advanced cursor is live: a second catch-up drains only what arrived since.
      await r.plugin.post(r.topic, asHandle('w'), 'three');
      await expect(r.drain()).resolves.toBe(1);
    } finally {
      await r.cleanup();
    }
  });

  it('drains only what is newer than a cursor this backend minted', async () => {
    const r = await rig('0-1');
    try {
      await r.plugin.post(r.topic, asHandle('w'), 'one');
      await expect(r.drain()).resolves.toBe(1);
      await expect(r.drain()).resolves.toBe(0);
    } finally {
      await r.cleanup();
    }
  });
});
