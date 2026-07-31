import { type Message, parseMentions } from '@sharptrick/parley-core';
import { expect, it, vi } from 'vitest';
import { drainAll, expectWellFormedMessage } from '../assertions.js';
import type { ConformanceContext } from '../factory.js';
import { OTHER, SENDER } from '../handles.js';

/**
 * How long a torn-down plugin is watched before its live path is called stopped. Long enough that a
 * subscription which outlived `disconnect()` has delivered, and far enough under the harness's own
 * per-case timeout that the assertion is what reports the leak.
 */
const TEARDOWN_SETTLE_MS = 500;

/** How long a handler is watched for a delivery; the echo case, writing to itself, waits less. */
const DELIVERY_MS = 5_000;
const ECHO_MS = 3_000;

const delivered = (within: number, arrived: () => void): Promise<void> =>
  vi.waitFor(arrived, { timeout: within, interval: 10 });

/** The push path: what `subscribe` delivers, to which topic, and what `disconnect` stops. */
export function liveCases(ctx: ConformanceContext): void {
  // The content carries an @mention so `mentions` is asserted non-vacuously on BOTH paths: core's
  // push loop drops every message whose `mentions` misses the identity when filtering is on.
  it('the same message has identical backendMsgId + cursor via live push and via catch-up', async () => {
    const t = ctx.freshTopic();
    const body = `x for @${OTHER}`;
    const live: Message[] = [];
    await ctx.plugin.subscribe(t, (m) => live.push(m));
    const id = await ctx.plugin.post(t, SENDER, body);
    await delivered(ECHO_MS, () => expect(live).toHaveLength(1));

    const viaCatchUp = (await ctx.plugin.fetchRecent({ topic: t })).messages.find(
      (m) => m.content === body,
    );
    expect(viaCatchUp).toBeDefined();
    expect(live[0]!.backendMsgId).toBe(id);
    expect(live[0]!.backendMsgId).toBe(viaCatchUp!.backendMsgId);
    expect(live[0]!.cursor).toBe(viaCatchUp!.cursor);
    expectWellFormedMessage(live[0]!, { topic: t, content: body });
    expectWellFormedMessage(viaCatchUp!, { topic: t, content: body });
    expect(live[0]!.mentions).toContain(OTHER);
    expect(viaCatchUp!.mentions).toContain(OTHER);
  });

  // Both of subscribe's documented guarantees at once: it delivers exactly the post-subscribe
  // tail (never replaying history as if it were live — a defect that has already bitten a
  // shipped backend) and it delivers in ascending cursor order.
  it('subscribe delivers exactly the post-subscribe tail, once, in cursor order', async () => {
    const t = ctx.freshTopic();
    const before = ['h0', 'h1', 'h2', 'h3', 'h4'];
    for (const c of before) await ctx.plugin.post(t, SENDER, c);

    const live: Message[] = [];
    await ctx.plugin.subscribe(t, (m) => live.push(m));

    const after = ['n0', 'n1', 'n2'];
    for (const c of after) await ctx.plugin.post(t, SENDER, c);
    await delivered(DELIVERY_MS, () => expect(live.length).toBeGreaterThanOrEqual(after.length));

    // Delivery ORDER is the assertion; cursor VALUES are opaque and deliberately not comparable
    // (CLAUDE.md — core never compares cursors, and MAM archive ids are not lexically sortable).
    expect(live.map((m) => m.content)).toEqual(after); // no history replay, nothing extra
    expect(new Set(live.map((m) => m.backendMsgId)).size).toBe(after.length); // exactly once
    const viaCatchUp = await drainAll(ctx.plugin, t);
    expect(viaCatchUp.map((m) => m.content)).toEqual([...before, ...after]);
    // Live and catch-up agree on identity for the same messages, in the same order.
    expect(live.map((m) => m.backendMsgId)).toEqual(
      viaCatchUp.slice(before.length).map((m) => m.backendMsgId),
    );
  });

  // Every other subscribe case posts through the SAME client that registered the handler, so only
  // this one can see a plugin whose live path merely echoes its own writes — a loopback with no
  // server-side listener at all, which is precisely the case Parley exists for: a human posts in
  // chat, an agent must receive it. Two writers, because SQLite's fixture counts `ctx.plugin` as
  // one of the contending writers.
  it('subscribe delivers a message written by an independent client', async (testCtx) => {
    if (ctx.concurrentPost === 'unsupported') {
      testCtx.skip();
      return;
    }
    const t = ctx.freshTopic();
    const live: Message[] = [];
    await ctx.plugin.subscribe(t, (m) => live.push(m));
    await ctx.concurrentPost(t, 2, 1);
    await delivered(DELIVERY_MS, () => expect(live.length).toBeGreaterThanOrEqual(2));

    const viaCatchUp = await drainAll(ctx.plugin, t);
    expect(viaCatchUp).toHaveLength(2);
    // Compared as SETS: two independent writers race, and the suite grades live ORDER against a
    // single writer elsewhere. What is graded here is that both writes arrived, exactly once,
    // under the same identity catch-up reports — the agreement core's dedup depends on.
    const ids = (ms: Message[]): string[] => ms.map((m) => String(m.backendMsgId)).sort();
    expect(live).toHaveLength(2);
    expect(ids(live)).toEqual(ids(viaCatchUp));
    for (const m of live) {
      expect(m.topic).toBe(t);
      expect(m.mentions).toEqual(parseMentions(m.content));
      expect(m.senderHandle.length).toBeGreaterThan(0);
    }
  });

  // The same property on the OTHER delivery path. Every other subscribe case uses one topic, so a
  // plugin whose live path ignored the topic filter passed: core would then emit a `<channel>`
  // event for a topic the allowlist never admitted.
  it('topics are isolated on the live path too', async () => {
    const a = ctx.freshTopic();
    const b = ctx.freshTopic();
    const inA: Message[] = [];
    const inB: Message[] = [];
    await ctx.plugin.subscribe(a, (m) => inA.push(m));
    await ctx.plugin.subscribe(b, (m) => inB.push(m));

    await ctx.plugin.post(a, SENDER, 'live-a');
    await ctx.plugin.post(b, SENDER, 'live-b');
    await delivered(DELIVERY_MS, () => {
      expect(inA.length).toBeGreaterThanOrEqual(1);
      expect(inB.length).toBeGreaterThanOrEqual(1);
    });

    expect(inA.map((m) => m.content)).toEqual(['live-a']);
    expect(inB.map((m) => m.content)).toEqual(['live-b']);
    for (const m of inA) expect(m.topic).toBe(a);
    for (const m of inB) expect(m.topic).toBe(b);
  });

  // `disconnect()` tears down the connection AND all subscriptions, and keeps serving nothing
  // afterwards. The live half is graded by WATCHING the handler across a settle window: re-reading
  // `live` the instant teardown returns cannot fail, because nothing in between could have
  // delivered. What the window catches is the loop or socket that outlived `disconnect()` and went
  // round once more. Grading it with a fresh WRITE instead is out of reach — a fixture may
  // legitimately count `ctx.plugin` as one of the contending writers `concurrentPost` drives, as
  // bridge-sqlite's deliberately does, so no client here survives the teardown.
  it('disconnect is idempotent and stops the plugin serving', async () => {
    const t = ctx.freshTopic();
    const live: Message[] = [];
    await ctx.plugin.subscribe(t, (m) => live.push(m));
    await ctx.plugin.post(t, SENDER, 'before-teardown');
    await delivered(DELIVERY_MS, () => expect(live).toHaveLength(1));

    await ctx.plugin.disconnect();
    await ctx.plugin.disconnect();

    await expect(ctx.plugin.post(t, SENDER, 'after-teardown')).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, TEARDOWN_SETTLE_MS));
    expect(live, 'a torn-down plugin delivered again — something outlived disconnect()').toHaveLength(
      1,
    );
  });
}
