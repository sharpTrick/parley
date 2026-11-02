import { asHandle, type Handle, type Message } from '@sharptrick/parley-core';
import { expect, it, vi } from 'vitest';
import type { ConformanceContext } from '../factory.js';
import { SENDER } from '../handles.js';
import { DELIVERY_MS, livePayload, QUIET_DELIVERY_MS } from './live.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every handle a message is explicitly addressed to is one it mentions: a feed delivers by mentions. */
const expectAddressedWithinMentions = (m: Message): void => {
  for (const handle of m.addressed ?? []) expect(m.mentions, 'addressed-within-mentions').toContain(handle);
};

/**
 * The seam's optional mention feed. A backend that offers `subscribeMentions` promises what
 * `subscribe` does — at most once, in order per topic, only what arrives after the call — across
 * EVERY topic, narrowed to what names the handle. A backend that does not offer it is held to what
 * the seam promises in its place: a mention still reaches whoever follows the topic it was posted on.
 */
export function mentionFeedCases(ctx: ConformanceContext): void {
  it('subscribeMentions, where offered, delivers what names the handle from any topic and nothing else', async () => {
    const me: Handle = asHandle(`m${livePayload()}`);
    const got: Message[] = [];
    if (ctx.plugin.subscribeMentions === undefined) {
      const topic = ctx.freshTopic();
      await ctx.plugin.subscribe(topic, (m) => got.push(m));
      await ctx.plugin.post(topic, SENDER, `${livePayload()} for @${me}`);
      await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: DELIVERY_MS, interval: 10 });
      expect(got[0]!.mentions).toContain(me);
      expectAddressedWithinMentions(got[0]!);
      return;
    }
    const [first, second] = [ctx.freshTopic(), ctx.freshTopic()];
    await ctx.plugin.post(first, SENDER, `${livePayload()} before the feed, for @${me}`);
    await ctx.plugin.subscribeMentions(me, (m) => got.push(m));

    const expected: Record<string, string[]> = { [first]: [], [second]: [] };
    const named = async (topic: typeof first, content: string): Promise<void> => {
      expected[topic]!.push(content);
      await ctx.plugin.post(topic, SENDER, content);
    };
    await ctx.plugin.post(first, SENDER, `${livePayload()} for nobody`);
    await ctx.plugin.post(second, SENDER, `${livePayload()} for @x${livePayload()}`);
    await named(first, `${livePayload()} for @${me}`);
    await named(second, `@${me} ${livePayload()}`);
    await named(first, `${livePayload()} again for @${me}`);

    const total = expected[first]!.length + expected[second]!.length;
    await vi.waitFor(() => expect(got).toHaveLength(total), { timeout: DELIVERY_MS, interval: 10 });
    await sleep(QUIET_DELIVERY_MS);
    // At most once, in order per topic, and only what named the handle after the call.
    const delivered = (topic: string): string[] => got.filter((m) => m.topic === topic).map((m) => m.content);
    expect({ [first]: delivered(first), [second]: delivered(second), total: got.length }).toEqual({
      ...expected,
      total,
    });
    for (const m of got) {
      expect(m.mentions).toContain(me);
      expectAddressedWithinMentions(m);
    }
  });
}
