/**
 * Zulip reads several request flags whose DEFAULT is the wrong value for a bridge: content comes
 * back rendered as HTML, a narrowed read includes its own anchor, an events poll can be told not to
 * block. Each is a one-word omission with a silent, wide blast radius — rendered HTML becomes agent
 * context (DESIGN §14), an included anchor breaks exclusive catch-up, a non-blocking poll turns
 * push into a spin.
 *
 * Every row asserts BOTH halves, because either alone is worthless: that the plugin gets the
 * bridge's behaviour, and that the fake genuinely diverges on the default — a flag the fake ignores
 * is a flag no test can grade.
 */
import { asTopic, type Cursor, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { renderMarkdown, SERVER_CONSTRAINTS } from './fake-zulip.js';
import { rand, SENDER, sleep, useZulip, type ZulipPair } from './harness.js';

const boot = useZulip();

const SOURCE = '**bold** @someone https://example.com';

async function raw(
  { fake }: ZulipPair,
  method: string,
  path: string,
  query: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${fake.url}${path}?${new URLSearchParams(query)}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from('parley-bot@localhost:parley-api-key').toString('base64')}`,
    },
  });
  return (await res.json()) as Record<string, unknown>;
}

const narrowFor = (topic: string): string =>
  JSON.stringify([
    { operator: 'stream', operand: 'parley' },
    { operator: 'topic', operand: topic.toLowerCase() },
  ]);

interface FlagRow {
  flag: keyof typeof SERVER_CONSTRAINTS.requestFlagDefaults;
  /** Fake/plugin settings this row needs on top of the shared fixture's defaults. */
  boot?: { heartbeatMs: number; config: Record<string, unknown> };
  /** What the bridge must observe when the plugin sends the non-default value. */
  pluginGets: (pair: ZulipPair, topic: string) => Promise<void>;
  /** What the SERVER DEFAULT does instead — proves the fake can tell the two apart. */
  defaultGives: (pair: ZulipPair, topic: string) => Promise<void>;
}

const FLAGS: FlagRow[] = [
  {
    flag: 'apply_markdown',
    pluginGets: async ({ plugin }, topic) => {
      const t = asTopic(topic);
      const live: Message[] = [];
      await plugin.subscribe(t, (m) => live.push(m));
      await plugin.post(t, SENDER, SOURCE);
      const { messages } = await plugin.fetchRecent({ topic: t });
      expect(messages.map((m) => m.content)).toEqual([SOURCE]);
      await vi.waitFor(() => expect(live.map((m) => m.content)).toEqual([SOURCE]), {
        timeout: 3000,
        interval: 10,
      });
    },
    defaultGives: async (pair, topic) => {
      await pair.plugin.post(asTopic(topic), SENDER, SOURCE);
      const body = await raw(pair, 'GET', '/api/v1/messages', {
        narrow: narrowFor(topic),
        anchor: 'newest',
        num_before: '10',
        num_after: '0',
      });
      const messages = body.messages as Array<{ content: string }>;
      expect(messages.map((m) => m.content)).toEqual([renderMarkdown(SOURCE)]);
      expect(renderMarkdown(SOURCE)).not.toBe(SOURCE);
    },
  },
  {
    flag: 'include_anchor',
    pluginGets: async ({ plugin }, topic) => {
      const t = asTopic(topic);
      await plugin.post(t, SENDER, 'first');
      const tail = (await plugin.fetchRecent({ topic: t })).nextCursor as Cursor;
      await plugin.post(t, SENDER, 'second');
      const { messages } = await plugin.fetchRecent({ topic: t, since: tail });
      expect(messages.map((m) => m.content)).toEqual(['second']);
    },
    defaultGives: async (pair, topic) => {
      const t = asTopic(topic);
      await pair.plugin.post(t, SENDER, 'first');
      const tail = (await pair.plugin.fetchRecent({ topic: t })).nextCursor as Cursor;
      await pair.plugin.post(t, SENDER, 'second');
      const body = await raw(pair, 'GET', '/api/v1/messages', {
        narrow: narrowFor(topic),
        anchor: String(tail),
        num_before: '0',
        num_after: '10',
        apply_markdown: 'false',
      });
      const messages = body.messages as Array<{ content: string }>;
      expect(messages.map((m) => m.content)).toEqual(['first', 'second']);
    },
  },
  {
    flag: 'dont_block',
    boot: { heartbeatMs: 5000, config: { events_timeout_ms: 5000 } },
    pluginGets: async ({ plugin, fake }, topic) => {
      const t = asTopic(topic);
      const live: Message[] = [];
      await plugin.subscribe(t, (m) => live.push(m));
      // Nothing is queued and nothing answers for 5s, so a poll that BLOCKS costs one request
      // across the window; one that returns at once has to be reissued to keep push alive.
      const pollsBefore = fake.requestCount('GET /api/v1/events');
      await sleep(700);
      expect(fake.requestCount('GET /api/v1/events') - pollsBefore).toBeLessThanOrEqual(1);
      fake.injectMessage({ topic, content: 'pushed' });
      await vi.waitFor(() => expect(live.map((m) => m.content)).toEqual(['pushed']), {
        timeout: 3000,
        interval: 10,
      });
    },
    defaultGives: async (pair) => {
      const reg = (await raw(pair, 'POST', '/api/v1/register', {})) as { queue_id?: string };
      const started = Date.now();
      const body = await raw(pair, 'GET', '/api/v1/events', {
        queue_id: String(reg.queue_id),
        last_event_id: '-1',
        dont_block: 'true',
      });
      expect(body.events).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1000); // this queue's heartbeat is 5s away
    },
  },
];

describe('zulip sends the wire-format flag a bridge needs, and the fake tells them apart', () => {
  for (const row of FLAGS) {
    const open = async (): Promise<ZulipPair> =>
      row.boot === undefined
        ? boot()
        : boot({ heartbeatMs: row.boot.heartbeatMs }, row.boot.config);

    it(`${row.flag}: the plugin overrides the server default`, async () => {
      await row.pluginGets(await open(), `flag-${rand()}`);
    });

    it(`${row.flag}: the fake behaves differently on the server default`, async () => {
      await row.defaultGives(await open(), `flag-${rand()}`);
    });
  }
});
