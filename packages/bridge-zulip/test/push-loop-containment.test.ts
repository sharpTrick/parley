/**
 * CLASS: no throw anywhere inside the push loop may end push for a topic or escape as an unhandled
 * rejection. The loop's own error handling covers the awaits it wraps — the handler call, the HTTP
 * poll, the gap-fill read — and nothing else, so any throw at a site nobody enumerated rejects
 * `loop()`. `disconnect()` settles that promise, but the fire-and-forget `void running.finally(…)`
 * derived from it has no handler at all, and on Node 22 an unhandled rejection is an uncaught
 * exception: `src/cli.ts` installs no handler, so the MCP stdio server exits.
 *
 * This is the TRANSIENT axis of the shared fault vocabulary: every shape the server can answer a
 * poll with, injected ONCE, grading three independent properties per row — the process stays clean,
 * the loop resumes delivering on both sides of the fault, and one bad answer is not reported to the
 * operator as an outage. Survival is all this axis can see: a loop that spins flat out for the one
 * request looks exactly like one that paces, which is why `operability.test.ts` runs the same
 * vocabulary persistently and grades the request RATE.
 */
import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { TRANSIENT_EVENTS_FAULTS } from './fake-zulip.js';
import { rand, SENDER, sleep, useZulip } from './harness.js';

const boot = useZulip();

/** Collect what Node would otherwise turn into an uncaught exception. */
async function withRejectionCollector(body: (rejections: unknown[]) => Promise<void>): Promise<void> {
  const rejections: unknown[] = [];
  const collect = (err: unknown): void => void rejections.push(err);
  process.on('unhandledRejection', collect);
  try {
    await body(rejections);
  } finally {
    process.off('unhandledRejection', collect);
  }
}

const parleyErrors = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[parley-zulip]'));

describe('one bad events answer is tolerated without ending push', () => {
  for (const row of TRANSIENT_EVENTS_FAULTS) {
    it(`survives a single ${row.key} answer and keeps delivering`, async () => {
      await withRejectionCollector(async (rejections) => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { plugin, fake } = await boot();
        const topic = asTopic(`fault-${rand()}`);

        const got: Message[] = [];
        await plugin.subscribe(topic, (m) => got.push(m));
        // Deliver first, so the watermark is past the message a re-served event carries: an
        // un-ackable event hands back one the handler has already seen, not a new one.
        await plugin.post(topic, SENDER, 'before the fault');
        await sleep(300);
        fake.failRoute('GET /api/v1/events', row.failure);
        await sleep(300);
        await plugin.post(topic, SENDER, 'after the fault');
        await sleep(600);

        expect(rejections).toEqual([]);
        expect(got.map((m) => m.content)).toEqual(['before the fault', 'after the fault']);
        expect(parleyErrors(error)).toEqual([]);
      });
    }, 20_000);
  }
});

describe('a handler that throws never breaks the loop it is attached to', () => {
  it('every later message still reaches it, and nothing escapes as a rejection', async () => {
    await withRejectionCollector(async (rejections) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { plugin } = await boot();
      const topic = asTopic(`throwing-handler-${rand()}`);
      const seen: string[] = [];
      await plugin.subscribe(topic, (m) => {
        seen.push(m.content);
        throw new Error('handler exploded');
      });

      await plugin.post(topic, SENDER, 'first');
      await sleep(400);
      await plugin.post(topic, SENDER, 'second');
      await sleep(400);

      expect(rejections).toEqual([]);
      expect(seen).toEqual(['first', 'second']);
      expect(parleyErrors(error)).toEqual([]);
    });
  }, 20_000);
});
