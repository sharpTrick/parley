import { asHandle, type Message } from '@sharptrick/parley-core';
import { expect, it, vi } from 'vitest';
import type { ConformanceContext } from '../factory.js';
import { SENDER } from '../handles.js';
import { DELIVERY_MS, livePayload, QUIET_DELIVERY_MS } from './live.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The seam's optional mention feed. A backend that offers `subscribeMentions` promises what
 * `subscribe` does — at most once, in order, only what arrives after the call — across EVERY topic,
 * narrowed to what names the handle. A backend that does not offer it is held to what the seam
 * promises in its place: a mention still reaches whoever follows the topic it was posted on.
 */
export function mentionFeedCases(ctx: ConformanceContext): void {
  it('subscribeMentions, where offered, delivers what names the handle from any topic and nothing else', async () => {
    const me = asHandle(`m${livePayload()}`);
    const got: Message[] = [];
    if (ctx.plugin.subscribeMentions === undefined) {
      // Without a feed, a mention still reaches whoever follows the topic it was posted on.
      const topic = ctx.freshTopic();
      await ctx.plugin.subscribe(topic, (m) => got.push(m));
      await ctx.plugin.post(topic, SENDER, `${livePayload()} for @${me}`);
      await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: DELIVERY_MS, interval: 10 });
      expect(got[0]!.mentions).toContain(me);
      return;
    }
    await ctx.plugin.subscribeMentions(me, (m) => got.push(m));

    const [first, second] = [ctx.freshTopic(), ctx.freshTopic()];
    const named = [
      [first, `${livePayload()} for @${me}`],
      [second, `@${me} ${livePayload()}`],
    ] as const;
    await ctx.plugin.post(first, SENDER, `${livePayload()} for nobody`);
    await ctx.plugin.post(second, SENDER, `${livePayload()} for @x${livePayload()}`);
    for (const [topic, content] of named) await ctx.plugin.post(topic, SENDER, content);

    await vi.waitFor(() => expect(got).toHaveLength(named.length), { timeout: DELIVERY_MS, interval: 10 });
    await sleep(QUIET_DELIVERY_MS);
    // Order is promised per topic, and each topic here carries one named message.
    const byTopic = (rows: Array<readonly [string, string]>): string[] => rows.map((r) => r.join('\n')).sort();
    expect(byTopic(got.map((m) => [m.topic, m.content]))).toEqual(byTopic([...named]));
    for (const m of got) expect(m.mentions).toContain(me);
  });
}
