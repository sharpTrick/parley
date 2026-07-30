/**
 * CLASS: a vendor routing rule the README gives operational advice on must be encoded in the
 * fixture, not asserted in prose. Socket Mode does not fan an event out to an app's open
 * connections — each payload goes to exactly ONE of them, with no guaranteed pattern — so two
 * Parley sessions sharing one `app_token` each see an arbitrary subset of the live stream. The
 * README once claimed the opposite and blessed "at least its own bot user" on the strength of it.
 *
 * The rows below state the two halves of the rule the advice turns on: one session on its own app
 * sees everything; two sessions sharing an app do not, and neither can tell that it missed anything
 * from the live path alone — only catch-up recovers the difference.
 */
import { asTopic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { SlackPlugin } from '../src/index.js';
import { startSlack } from './harness.js';

const PUSHED = 20;

describe('slack Socket Mode routes each event to one connection', () => {
  it('a single session on its own app_token receives every event', async () => {
    const topic = asTopic('C0SOLO');
    const { fake, plugin, cleanup } = await startSlack({ channels: [topic] });
    try {
      const seen: string[] = [];
      await plugin.subscribe(topic, (m) => seen.push(m.content));
      for (let i = 0; i < PUSHED; i++) {
        fake.pushEvent(topic, { ts: fake.mintTs(), text: `m${i}`, user: 'U0X' });
      }
      await vi.waitFor(() => expect(seen).toHaveLength(PUSHED), { timeout: 3000, interval: 10 });
    } finally {
      await cleanup();
    }
  });

  it('two sessions sharing one app_token split the stream, and catch-up is what repairs it', async () => {
    const topic = asTopic('C0SHARED');
    const { fake, plugin: first, cleanup } = await startSlack({ channels: [topic] });
    const second = new SlackPlugin();
    await second.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
    try {
      const seenFirst: string[] = [];
      const seenSecond: string[] = [];
      await first.subscribe(topic, (m) => seenFirst.push(m.content));
      await second.subscribe(topic, (m) => seenSecond.push(m.content));

      const texts = Array.from({ length: PUSHED }, (_, i) => `m${i}`);
      for (const text of texts) {
        const [created] = fake.seed(topic, [{ text }]);
        fake.pushEvent(topic, { ts: created!.ts, text, user: 'U0X' });
      }
      await vi.waitFor(
        () => expect(seenFirst.length + seenSecond.length).toBe(PUSHED),
        { timeout: 3000, interval: 10 },
      );

      // The harm the README's advice exists to prevent: each session's LIVE view is partial, and
      // nothing in the live path tells it so.
      expect(seenFirst.length, 'first session live share').toBeGreaterThan(0);
      expect(seenFirst.length, 'first session live share').toBeLessThan(PUSHED);
      expect(seenSecond.length, 'second session live share').toBeGreaterThan(0);
      expect(seenSecond.length, 'second session live share').toBeLessThan(PUSHED);
      expect([...seenFirst, ...seenSecond].sort()).toEqual([...texts].sort());

      // …and the repair, which is why the split is a latency/attribution problem and not data loss.
      for (const [name, plugin] of [
        ['first', first],
        ['second', second],
      ] as const) {
        const { messages } = await plugin.fetchRecent({ topic, limit: PUSHED });
        expect(messages.map((m) => m.content), name).toEqual(texts);
      }
    } finally {
      await second.disconnect();
      await cleanup();
    }
  });
});
