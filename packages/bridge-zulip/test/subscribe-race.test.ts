/**
 * The `subscribe()` handshake is a sequence of network round trips, and every gap between them is
 * a window where a message can land. These tables walk each window: the live path must never seed
 * its delivery watermark from state observed after the queue exists, and a topic must be
 * advertised as piggyback-able only while a loop is actually draining it.
 */
import { asTopic, type Cursor, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import type { FakeZulip } from './fake-zulip.js';
import { rand, SENDER, useZulip } from './harness.js';

const boot = useZulip();

/** Each window inside the handshake, named by the response the fake has just written. */
const INJECTION_POINTS = [
  { name: 'between the tail probe and the queue registration', after: 'GET /api/v1/messages' },
  { name: 'between the queue registration and the first events poll', after: 'POST /api/v1/register' },
  { name: 'while the first events poll is parked', after: 'GET /api/v1/events' },
];

describe('zulip subscribe handshake windows', () => {
  for (const point of INJECTION_POINTS) {
    it(`delivers a message landing ${point.name} exactly once, in order`, async () => {
      const { plugin, fake } = await boot();
      const topic = asTopic(`race-${rand()}`);
      await plugin.post(topic, SENDER, 'history');

      const got: Message[] = [];
      let injected = false;
      fake.setResponseHook((route) => {
        if (injected || route !== point.after) return;
        injected = true;
        fake.injectMessage({ topic, content: 'racer' });
      });
      await plugin.subscribe(topic, (m) => got.push(m));
      await vi.waitFor(() => expect(injected).toBe(true), { timeout: 3000, interval: 5 });
      fake.setResponseHook(undefined);
      await plugin.post(topic, SENDER, 'after');

      await vi.waitFor(() => expect(got.map((m) => m.content)).toEqual(['racer', 'after']), {
        timeout: 5000,
        interval: 10,
      });
      // Settle: neither the queue nor the gap-fill may hand the racer over a second time, and
      // history from before the subscription must never be replayed.
      await new Promise((r) => setTimeout(r, 400));
      expect(got.map((m) => m.content)).toEqual(['racer', 'after']);
    });
  }
});

/** Every way the handshake can end without a live loop behind it. */
const DEAD_SUBSCRIBE_MODES = [
  {
    name: 'the tail probe fails',
    break: (fake: FakeZulip) => fake.failNextMessagesRead(),
    repair: (fake: FakeZulip) => fake.clearRouteFailures(),
  },
  {
    name: 'register fails',
    break: (fake: FakeZulip) => fake.failRoute('POST /api/v1/register', { status: 500 }),
    repair: (fake: FakeZulip) => fake.clearRouteFailures(),
  },
];

describe('zulip blocking fetchRecent never parks on a dead subscription', () => {
  for (const mode of DEAD_SUBSCRIBE_MODES) {
    it(`wakes on a concurrent post after subscribe() failed because ${mode.name}`, async () => {
      const { plugin, fake } = await boot();
      const topic = asTopic(`dead-${rand()}`);
      await plugin.post(topic, SENDER, 'old');
      const tail = (await plugin.fetchRecent({ topic })).nextCursor;

      mode.break(fake);
      await expect(plugin.subscribe(topic, () => undefined)).rejects.toThrow();
      mode.repair(fake);

      const started = Date.now();
      const late = setTimeout(() => void plugin.post(topic, SENDER, 'late'), 100);
      const res = await plugin.fetchRecent({ topic, since: tail, blockMs: 3000 });
      clearTimeout(late);
      expect(res.messages.map((m) => m.content)).toEqual(['late']);
      expect(Date.now() - started).toBeLessThan(1500);
    });
  }

  it('wakes on a concurrent post after disconnect raced the subscribe handshake', async () => {
    const { plugin, fake } = await boot();
    const topic = asTopic(`raced-${rand()}`);
    await plugin.post(topic, SENDER, 'old');

    const subscribed = plugin.subscribe(topic, () => undefined).catch(() => undefined);
    await plugin.disconnect();
    await subscribed;

    await plugin.connect({ site_url: fake.url, events_timeout_ms: 500 });
    const tail = (await plugin.fetchRecent({ topic })).nextCursor as Cursor;
    const started = Date.now();
    const late = setTimeout(() => void plugin.post(topic, SENDER, 'late'), 100);
    const res = await plugin.fetchRecent({ topic, since: tail, blockMs: 3000 });
    clearTimeout(late);
    expect(res.messages.map((m) => m.content)).toEqual(['late']);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
