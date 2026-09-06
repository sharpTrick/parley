/**
 * The `subscribe()` handshake is a sequence of network round trips, and every gap between them is a
 * window where a message can land. Push is a SUBSET of the post-subscribe tail (DESIGN §6), so a
 * message that reaches the server before this plugin's queue exists is a gap catch-up closes rather
 * than one the live path owes. What these tables walk is the other half, which the relaxation did
 * not touch: no window may deliver a message TWICE, and none may replay history as if it were live.
 */
import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { MAX_MESSAGES_PER_FETCH } from '../src/wire.js';
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
 * CLASS: a record the read cannot use is not the end of history, and it is not a live event either.
 * A history read is the only thing that meets one now, so it must neither be replayed through the
 * live handler nor mistaken for an empty topic. The table crosses every unusable shape the newest
 * record can arrive in with the history behind it, including a whole server page of them.
 */
describe('zulip subscribe never replays history, whatever the records behind it look like', () => {
  /**
   * Shapes of `id` that make a record unusable — it is both the dedup key and the cursor. Only the
   * shapes a server can ORDER are here: an id that is not a comparable number lands in no read
   * window at all, and it is graded on the push path instead (untrusted-payload.test.ts drives every
   * hazard shape through a live queue).
   */
  const UNUSABLE_IDS: Array<{ name: string; value: unknown }> = [
    { name: 'zero', value: 0 },
    { name: 'negative', value: -1 },
    { name: 'fractional', value: 1.5 },
    { name: 'past the safe-integer range', value: 1e18 },
  ];
  /** Straddles a server page, so a replay would also have to paginate to be complete. */
  const HISTORIES = [0, 1, 3, MAX_MESSAGES_PER_FETCH + 1];

  for (const shape of UNUSABLE_IDS) {
    for (const history of HISTORIES) {
      it(`delivers only the post-subscribe tail past a newest record whose id is ${shape.name}, over ${history} message(s) of history`, async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { plugin, fake } = await boot();
        const topic = asTopic(`watermark-${rand()}`);
        for (let i = 0; i < history; i++) fake.injectMessage({ topic, content: `h${i}` });
        fake.injectRaw({ topic, fields: { id: shape.value } });

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
    }
  }
});
