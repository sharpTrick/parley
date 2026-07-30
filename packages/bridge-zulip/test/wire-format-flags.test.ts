/**
 * Zulip reads several request flags a bridge must pin: content comes back rendered as HTML unless
 * asked otherwise, a narrowed read includes its own anchor, an events poll can be told not to block.
 * Each is a one-word omission with a silent, wide blast radius — rendered HTML becomes agent context
 * (DESIGN §14), an included anchor breaks exclusive catch-up, a non-blocking poll turns push into a
 * spin.
 *
 * Every row asserts THREE things, because no two of them reach the whole hazard: that the bridge gets
 * the behaviour it needs, that the value is on the WIRE rather than inherited from a server default
 * that happens to agree today, and that the fake genuinely behaves differently on some other value —
 * a flag the fake ignores is a flag no behavioural case can grade.
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
  /** The route the flag must appear on, and the value the plugin must put there explicitly. */
  wire: { route: string; value: string };
  /** Fake/plugin settings this row needs on top of the shared fixture's defaults. */
  boot?: { heartbeatMs: number; config: Record<string, unknown> };
  /** What the bridge must observe. Also the run whose emitted requests the wire check reads. */
  pluginGets: (pair: ZulipPair, topic: string) => Promise<void>;
  /** A value the FAKE behaves differently on — never the one the bridge itself sends. */
  divergesOn: string;
  /** What the fake does on {@link FlagRow.divergesOn} — proves it can tell the two apart. */
  divergenceShows: (pair: ZulipPair, topic: string) => Promise<void>;
}

const FLAGS: FlagRow[] = [
  {
    flag: 'apply_markdown',
    wire: { route: 'GET /api/v1/messages', value: 'false' },
    divergesOn: 'true',
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
    divergenceShows: async (pair, topic) => {
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
    wire: { route: 'GET /api/v1/messages', value: 'false' },
    divergesOn: 'true',
    pluginGets: async ({ plugin }, topic) => {
      const t = asTopic(topic);
      await plugin.post(t, SENDER, 'first');
      const tail = (await plugin.fetchRecent({ topic: t })).nextCursor as Cursor;
      await plugin.post(t, SENDER, 'second');
      const { messages } = await plugin.fetchRecent({ topic: t, since: tail });
      expect(messages.map((m) => m.content)).toEqual(['second']);
    },
    divergenceShows: async (pair, topic) => {
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
    wire: { route: 'GET /api/v1/events', value: 'false' },
    divergesOn: 'true',
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
    divergenceShows: async (pair) => {
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

    it(`${row.flag}: the bridge gets the behaviour it needs`, async () => {
      await row.pluginGets(await open(), `flag-${rand()}`);
    });

    it(`${row.flag}=${row.wire.value} is on the wire, not inherited from a default`, async () => {
      const pair = await open();
      await row.pluginGets(pair, `flag-${rand()}`);
      const sent = pair.fake.sentParams(row.wire.route);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.filter((p) => p[row.flag] === undefined)).toEqual([]);
      expect(sent.some((p) => p[row.flag] === row.wire.value)).toBe(true);
    });

    it(`${row.flag}: the fake behaves differently on ${row.divergesOn}`, async () => {
      await row.divergenceShows(await open(), `flag-${rand()}`);
    });
  }
});

/**
 * The table's own preconditions. A behavioural row can only grade a flag the fake reacts to, and only
 * a wire assertion can grade one whose server default already equals what the bridge wants — so every
 * flag the fake models needs both, and the hostile set is pinned BY VALUE so that a default which
 * changes to agree with the bridge cannot quietly disarm the row that was grading it.
 */
describe('the wire-format flag table cannot go silently inert', () => {
  it('grades every flag the fake models', () => {
    expect(FLAGS.map((r) => r.flag).sort()).toEqual(
      Object.keys(SERVER_CONSTRAINTS.requestFlagDefaults).sort(),
    );
  });

  it('never grades a divergence against the value the bridge itself sends', () => {
    expect(FLAGS.filter((r) => r.divergesOn === r.wire.value).map((r) => r.flag)).toEqual([]);
  });

  it('names which server defaults are hostile and which already agree with the bridge', () => {
    const hostile = FLAGS.filter(
      (r) => SERVER_CONSTRAINTS.requestFlagDefaults[r.flag] !== r.wire.value,
    );
    expect(hostile.map((r) => r.flag)).toEqual(['apply_markdown', 'include_anchor']);
    expect(SERVER_CONSTRAINTS.requestFlagDefaults.dont_block).toBe('false');
  });
});
