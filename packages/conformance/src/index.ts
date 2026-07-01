import { asHandle, type BackendPlugin, type Message, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendFactory, ConformanceContext } from './factory.js';

export type { BackendFactory, ConformanceContext } from './factory.js';

const SENDER = asHandle('writer');

/** Fetch with a generous limit so we see every message in `topic`, ascending. */
async function drainAll(plugin: BackendPlugin, topic: Topic, expectedAtMost = 10_000): Promise<Message[]> {
  const { messages } = await plugin.fetchRecent({ topic, limit: expectedAtMost });
  return messages;
}

/**
 * The shared seam conformance suite (DESIGN §6; CLAUDE.md testing discipline). A backend
 * conforms iff: stable-unique backendMsgId AND monotonic, in-order, exclusive-`since` cursor
 * delivery. Write once here; run against every backend via {@link BackendFactory}.
 */
export function runConformanceSuite(name: string, factory: BackendFactory): void {
  describe(`seam conformance: ${name}`, () => {
    let ctx: ConformanceContext;
    beforeEach(async () => {
      ctx = await factory();
    });
    afterEach(async () => {
      await ctx.cleanup();
    });

    it('post → fetchRecent returns messages in order, with unique ids and distinct cursors', async () => {
      const t = ctx.freshTopic();
      const ids = [];
      for (const c of ['a', 'b', 'c']) ids.push(await ctx.plugin.post(t, SENDER, c));
      expect(new Set(ids).size).toBe(3); // backendMsgId is unique

      const { messages, nextCursor } = await ctx.plugin.fetchRecent({ topic: t });
      expect(messages.map((m) => m.content)).toEqual(['a', 'b', 'c']);
      expect(new Set(messages.map((m) => m.backendMsgId)).size).toBe(3);
      expect(new Set(messages.map((m) => m.cursor)).size).toBe(3);
      expect(messages.map((m) => m.backendMsgId)).toEqual(ids); // post() ids match read ids
      expect(nextCursor).toBe(messages.at(-1)!.cursor);
    });

    it('catch-up since a cursor returns only newer messages (exclusive)', async () => {
      const t = ctx.freshTopic();
      await ctx.plugin.post(t, SENDER, 'a');
      await ctx.plugin.post(t, SENDER, 'b');
      const c1 = (await ctx.plugin.fetchRecent({ topic: t })).nextCursor;
      await ctx.plugin.post(t, SENDER, 'c');
      await ctx.plugin.post(t, SENDER, 'd');

      const after = await ctx.plugin.fetchRecent({ topic: t, since: c1 });
      expect(after.messages.map((m) => m.content)).toEqual(['c', 'd']);
      expect(after.nextCursor).toBe(after.messages.at(-1)!.cursor);
    });

    it('since at the tail returns empty and a stable cursor', async () => {
      const t = ctx.freshTopic();
      await ctx.plugin.post(t, SENDER, 'only');
      const tail = (await ctx.plugin.fetchRecent({ topic: t })).nextCursor;
      const drained = await ctx.plugin.fetchRecent({ topic: t, since: tail });
      expect(drained.messages).toEqual([]);
      expect(drained.nextCursor).toBe(tail);
    });

    it('the same message has identical backendMsgId + cursor via live push and via catch-up', async () => {
      const t = ctx.freshTopic();
      const live: Message[] = [];
      await ctx.plugin.subscribe(t, (m) => live.push(m));
      const id = await ctx.plugin.post(t, SENDER, 'x');
      await vi.waitFor(() => expect(live).toHaveLength(1), { timeout: 3000, interval: 10 });

      const viaCatchUp = (await ctx.plugin.fetchRecent({ topic: t })).messages.find(
        (m) => m.content === 'x',
      );
      expect(viaCatchUp).toBeDefined();
      expect(live[0]!.backendMsgId).toBe(id);
      expect(live[0]!.backendMsgId).toBe(viaCatchUp!.backendMsgId);
      expect(live[0]!.cursor).toBe(viaCatchUp!.cursor);
    });

    it('topics are isolated', async () => {
      const a = ctx.freshTopic();
      const b = ctx.freshTopic();
      await ctx.plugin.post(a, SENDER, 'in-a');
      await ctx.plugin.post(b, SENDER, 'in-b');
      expect((await ctx.plugin.fetchRecent({ topic: a })).messages.map((m) => m.content)).toEqual([
        'in-a',
      ]);
      expect((await ctx.plugin.fetchRecent({ topic: b })).messages.map((m) => m.content)).toEqual([
        'in-b',
      ]);
    });

    it('multi-process writes do not corrupt or error; cursor stays monotonic', async (testCtx) => {
      if (ctx.concurrentPost === undefined) {
        testCtx.skip();
        return;
      }
      const t = ctx.freshTopic();
      const writers = 4;
      const perWriter = 25;
      await ctx.concurrentPost(t, writers, perWriter);

      const all = await drainAll(ctx.plugin, t);
      expect(all).toHaveLength(writers * perWriter);
      expect(new Set(all.map((m) => m.backendMsgId)).size).toBe(writers * perWriter);
      expect(new Set(all.map((m) => m.cursor)).size).toBe(writers * perWriter);

      // Cursor ordering is real: since the k-th message returns exactly the messages after it.
      const k = Math.floor(all.length / 2);
      const rest = await ctx.plugin.fetchRecent({ topic: t, since: all[k]!.cursor, limit: 10_000 });
      expect(rest.messages.map((m) => m.backendMsgId)).toEqual(
        all.slice(k + 1).map((m) => m.backendMsgId),
      );
    });
  });
}
