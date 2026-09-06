/**
 * The `subscribe()` handshake is a sequence of network round trips, and every gap between them is a
 * window where a message can land. Push is a SUBSET of the post-subscribe tail (DESIGN §6), so a
 * message that reaches the server before this plugin's queue exists is a gap catch-up closes rather
 * than one the live path owes. What these tables walk is the other half, which the relaxation did
 * not touch: no window may deliver a message TWICE, and none may replay history as if it were live.
 */
import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { rand, SENDER, sleep, useZulip } from './harness.js';

const boot = useZulip();

/** Each window inside the handshake, named by the response the fake has just written. */
const INJECTION_POINTS = [
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
      // Settle: the queue may not hand the racer over a second time, and history from before the
      // subscription must never be replayed.
      await sleep(400);
      expect(got.map((m) => m.content)).toEqual(['racer', 'after']);
      expect(new Set(got.map((m) => m.backendMsgId)).size).toBe(got.length);
    });
  }

});

/**
 * `subscribe` reads no history at all: it registers a narrowed queue and resumes from the
 * `last_event_id` that registration hands back. So nothing BEHIND the subscription can reach the
 * live handler, and the shapes of the records back there cannot change that — which is why the
 * table that used to cross four unusable `id` shapes against four history depths (one of them a
 * whole server page, 5001 records) measured the same path sixteen times, at the cost of its own
 * settle each. The `id` shapes are graded where a record can actually reach the plugin: through a
 * live queue in `untrusted-payload.test.ts`, on the fake's own wire in `fixture-hygiene.test.ts`,
 * and on the record→Message path in `units.test.ts`.
 *
 * What is left is the property itself, over a topic that really does hold history — including a
 * record the read paths would refuse — so the case still fails if `subscribe` ever starts reading
 * back.
 */
describe('zulip subscribe never replays history, whatever the records behind it look like', () => {
  it('delivers only the post-subscribe tail past history ending in an unusable record', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { plugin, fake } = await boot();
    const topic = asTopic(`watermark-${rand()}`);
    for (let i = 0; i < 3; i++) fake.injectMessage({ topic, content: `h${i}` });
    fake.injectRaw({ topic, fields: { id: 0 } });

    const got: Message[] = [];
    await plugin.subscribe(topic, (m) => got.push(m));
    await plugin.post(topic, SENDER, 'after');

    await vi.waitFor(() => expect(got.map((m) => m.content)).toEqual(['after']), {
      timeout: 5000,
      interval: 10,
    });
    await sleep(400);
    expect(got.map((m) => m.content)).toEqual(['after']);
  }, 30_000);
});
