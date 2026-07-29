/**
 * A backend that fails in the background must stay cheap and stay visible, and a backend that
 * stops answering must not hold shutdown open. Both are operator-facing properties no conformance
 * case covers, so they get their own tables here.
 */
import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZulipPlugin } from '../src/index.js';
import { type FakeZulip, startFakeZulip } from './fake-zulip.js';

const rand = (): string => Math.random().toString(36).slice(2, 8);
const SENDER = asHandle('writer');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let open: Array<{ plugin: ZulipPlugin; fake: FakeZulip }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { plugin, fake } of open) {
    await plugin.disconnect().catch(() => undefined);
    await fake.close();
  }
  open = [];
});

async function boot(): Promise<{ plugin: ZulipPlugin; fake: FakeZulip }> {
  const fake = await startFakeZulip({ heartbeatMs: 200 });
  const plugin = new ZulipPlugin();
  await plugin.connect({ site_url: fake.url, events_timeout_ms: 500 });
  const pair = { plugin, fake };
  open.push(pair);
  return pair;
}

/** Ways the push loop can fail forever — none of them is recoverable by retrying harder. */
const PERMANENT_FAILURES = [
  {
    name: 'the api key was revoked (401 on /events)',
    counted: 'GET /api/v1/events',
    apply: (fake: FakeZulip) =>
      fake.failRoute('GET /api/v1/events', { status: 401, body: { result: 'error', msg: 'Invalid API key' } }),
  },
  {
    name: 'the server is broken (500 on /events)',
    counted: 'GET /api/v1/events',
    apply: (fake: FakeZulip) => fake.failRoute('GET /api/v1/events', { status: 500 }),
  },
  {
    name: 'a non-queue 400 on /events',
    counted: 'GET /api/v1/events',
    apply: (fake: FakeZulip) =>
      fake.failRoute('GET /api/v1/events', {
        status: 400,
        body: { result: 'error', code: 'BAD_REQUEST', msg: 'nope' },
      }),
  },
  {
    name: 're-register keeps failing after a queue GC',
    counted: 'POST /api/v1/register',
    apply: (fake: FakeZulip) => {
      fake.failRoute('POST /api/v1/register', { status: 500 });
      fake.gcQueues();
    },
  },
];

describe('zulip push loop backs off and reports when it fails permanently', () => {
  for (const mode of PERMANENT_FAILURES) {
    it(`escalates its retry wait and names the backend on stderr when ${mode.name}`, async () => {
      const { plugin, fake } = await boot();
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });

      const topic = asTopic(`loop-${rand()}`);
      const got: Message[] = [];
      await plugin.subscribe(topic, (m) => got.push(m));
      await plugin.post(topic, SENDER, 'live');
      await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 3000, interval: 10 });

      const before = fake.requestCount(mode.counted);
      mode.apply(fake);
      await sleep(3000);
      const attempts = fake.requestCount(mode.counted) - before;

      expect(attempts).toBeGreaterThan(0); // it is still trying
      expect(attempts).toBeLessThan(10); // …but not at a flat, hot interval
      expect(errors.filter((e) => e.includes('[parley-zulip]')).length).toBeGreaterThan(0);
    });
  }
});

const SERVER_STATES = [
  { name: 'responsive', apply: () => undefined },
  { name: 'answering 500', apply: (fake: FakeZulip) => fake.failRoute('DELETE /api/v1/events', { status: 500 }) },
  { name: 'a black hole', apply: (fake: FakeZulip) => fake.hangRoute('DELETE /api/v1/events') },
];

describe('zulip disconnect completes in bounded time whatever the server does', () => {
  for (const state of SERVER_STATES) {
    for (const liveQueues of [0, 1, 3]) {
      it(`resolves with ${liveQueues} live queue(s) against ${state.name}`, async () => {
        const { plugin, fake } = await boot();
        for (let i = 0; i < liveQueues; i++) {
          await plugin.subscribe(asTopic(`down-${i}-${rand()}`), () => undefined);
        }
        state.apply(fake);

        const started = Date.now();
        const outcome = await Promise.race([
          plugin.disconnect().then(() => 'closed'),
          sleep(3000).then(() => 'stalled'),
        ]);
        expect(outcome).toBe('closed');
        expect(Date.now() - started).toBeLessThan(3000);
      });
    }
  }
});
