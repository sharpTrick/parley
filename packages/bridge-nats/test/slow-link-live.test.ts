import { asCursor, asHandle, asTopic, type Cursor } from '@sharptrick/parley-core';
import { afterAll, describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { dropStreams, isNatsUp, rand, SERVERS, serverTarget } from './helpers.js';
import { startTcpProxy } from './tcp-proxy.js';

// Class: a plugin's read patience is a budget spent waiting for the LINK, so any budget expressed as
// a constant is wrong for every link slower than the constant — and the failure is silent, because a
// pull the plugin itself closed early looks exactly like a topic with nothing new. The fake grades
// this too, but only the real driver decides when a pull is considered started: nats.js `fetch()`
// resolves as soon as the request is queued locally, before a single byte has left the host.
// A real server behind a latency proxy, so the latency is the only variable.
// Every test here is server-gated, and the file holds nothing else.

const suite = (await isNatsUp()) ? describe : describe.skip;

suite('nats reads over a slow link', () => {
  const tag = rand();
  const streamPrefix = `SL_${tag}_`;
  const cfg = { subject_prefix: `sl.${tag}.`, stream_prefix: streamPrefix };
  const contents = ['m1', 'm2', 'm3'];

  afterAll(async () => {
    await dropStreams(streamPrefix);
  });

  /** Seed a fresh topic over the direct link, then hand back the same topic to read over a slow one. */
  async function seeded(): Promise<ReturnType<typeof asTopic>> {
    const topic = asTopic(`slow-${rand()}`);
    const seeder = new NatsPlugin();
    await seeder.connect({ ...cfg, servers: SERVERS });
    try {
      for (const c of contents) await seeder.post(topic, asHandle('sys'), c);
    } finally {
      await seeder.disconnect();
    }
    return topic;
  }

  for (const latencyMs of [0, 150, 400]) {
    it(`a ${latencyMs}ms link still returns the whole catch-up page`, async () => {
      const topic = await seeded();
      const target = serverTarget();
      const proxy = await startTcpProxy(target.host, target.port, latencyMs);
      const plugin = new NatsPlugin();
      await plugin.connect({ ...cfg, servers: proxy.address });
      try {
        const page = await plugin.fetchRecent({ topic, since: asCursor('0') });
        expect(page.messages.map((m) => m.content)).toEqual(contents);
        expect(page.nextCursor).toBe(page.messages.at(-1)?.cursor);
      } finally {
        await plugin.disconnect();
        await proxy.close();
      }
    }, 120_000);
  }

  it('a slow link drains page by page instead of parking the cursor', async () => {
    const topic = await seeded();
    const target = serverTarget();
    const proxy = await startTcpProxy(target.host, target.port, 250);
    const plugin = new NatsPlugin();
    await plugin.connect({ ...cfg, servers: proxy.address });
    try {
      const seen: string[] = [];
      let since: Cursor = asCursor('0');
      for (let page = 0; page < contents.length + 2; page++) {
        const result = await plugin.fetchRecent({ topic, since, limit: 1 });
        if (result.messages.length === 0) break;
        seen.push(...result.messages.map((m) => m.content));
        expect(result.nextCursor).not.toBe(since);
        since = result.nextCursor;
      }
      expect(seen).toEqual(contents);
    } finally {
      await plugin.disconnect();
      await proxy.close();
    }
  }, 120_000);
});
