/**
 * CLASS: no throw anywhere inside the push loop may end push for a topic or escape as an unhandled
 * rejection. The loop's own error handling covers the awaits it wraps — the handler call, the HTTP
 * poll, the gap-fill read — and nothing else, so any throw at a site nobody enumerated rejects
 * `loop()`. `disconnect()` settles that promise, but the fire-and-forget `void running.finally(…)`
 * derived from it has no handler at all, and on Node 22 an unhandled rejection is an uncaught
 * exception: `src/cli.ts` installs no handler, so the MCP stdio server exits.
 *
 * The existing lifecycle and operability tables only ever inject TRANSPORT faults (status codes,
 * hangs, queue GCs). These rows inject faults inside the loop's own body instead — the shapes an
 * events response can take that no status code models — and grade three independent properties per
 * row: the process stays clean, the loop keeps delivering, and a tolerated shape is not reported as
 * a failure.
 */
import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import type { FakeZulip } from './fake-zulip.js';
import { rand, SENDER, sleep, useZulip } from './harness.js';

const boot = useZulip();

/** An events response body the plugin's declared `EventsResponse` says cannot arrive. */
const MALFORMED_EVENTS: Array<{ name: string; body: Record<string, unknown> }> = [
  { name: '`events` is an object, not an array', body: { result: 'success', events: {} } },
  { name: '`events` is a string', body: { result: 'success', events: 'nope' } },
  { name: '`events` holds nulls', body: { result: 'success', events: [null] } },
  { name: '`events` holds numbers', body: { result: 'success', events: [7] } },
  {
    name: 'a message event whose `message` is null',
    body: { result: 'success', events: [{ id: 0, type: 'message', message: null }] },
  },
  {
    name: 'a message event whose `message` is a string',
    body: { result: 'success', events: [{ id: 0, type: 'message', message: 'gotcha' }] },
  },
  { name: 'neither `result` nor `events`', body: {} },
];

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

describe('a malformed events response is tolerated without ending push', () => {
  for (const fault of MALFORMED_EVENTS) {
    it(fault.name, async () => {
      await withRejectionCollector(async (rejections) => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { plugin, fake }: { plugin: import('../src/index.js').ZulipPlugin; fake: FakeZulip } =
          await boot();
        const topic = asTopic(`fault-${rand()}`);
        fake.failRoute('GET /api/v1/events', { status: 200, body: fault.body, times: 1 });

        const got: Message[] = [];
        await plugin.subscribe(topic, (m) => got.push(m));
        await sleep(300);
        await plugin.post(topic, SENDER, 'after the fault');
        await sleep(600);

        expect(rejections).toEqual([]);
        expect(got.map((m) => m.content)).toEqual(['after the fault']);
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
