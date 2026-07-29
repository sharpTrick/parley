/**
 * CLASS: every field of an inbound Socket Mode envelope is vendor- or attacker-controlled, and the
 * plugin owes Slack an ack for ALL of them — including the ones it deliberately drops.
 *
 * Two failure shapes hide behind the happy path and are covered here from ONE table:
 *
 * (1) An unguarded dereference of an inbound field (`event.ts`) throws inside a `ws.on('message')`
 *     callback. There is no caller to propagate to, so it becomes an `uncaughtException` and takes
 *     the whole bridge process down. The waiter loop that a blocking `fetchRecent` parks runs
 *     BEFORE any route dispatch and outside its try/catch, so the arm with no route registered is
 *     the dangerous one — and the one nothing else in the suite drives.
 *
 * (2) Slack redelivers an unacked envelope and eventually drops the connection, so an ack that only
 *     lands for envelopes reaching a registered handler turns ordinary `channel_join` traffic into
 *     a redeliver/disconnect loop. The ack assertion therefore runs over dropped envelopes, not
 *     just surfaced ones.
 */
import { asCursor, asHandle, asTopic, type Message, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';

const ROUTED = 'C0ROUTED';
const UNROUTED = 'C0UNROUTED';

/** Envelope bodies the plugin must ack and must not die on. None of these may surface a message. */
const DROPPED: Array<{ name: string; body: (fake: FakeSlack) => Record<string, unknown> }> = [
  { name: 'events_api with no payload', body: () => ({ type: 'events_api' }) },
  { name: 'events_api with a null payload', body: () => ({ type: 'events_api', payload: null }) },
  {
    name: 'events_api with no event',
    body: () => ({ type: 'events_api', payload: { not_event: 1 } }),
  },
  {
    name: 'event with no ts',
    body: () => ({ type: 'events_api', payload: { event: { type: 'message', channel: ROUTED, text: 'x' } } }),
  },
  {
    name: 'event with a null ts',
    body: () => ({ type: 'events_api', payload: { event: { type: 'message', channel: ROUTED, ts: null } } }),
  },
  {
    name: 'event with a numeric ts',
    body: () => ({ type: 'events_api', payload: { event: { type: 'message', channel: ROUTED, ts: 42 } } }),
  },
  {
    name: 'event with an empty ts',
    body: () => ({ type: 'events_api', payload: { event: { type: 'message', channel: ROUTED, ts: '' } } }),
  },
  {
    name: 'event with a non-numeric ts',
    body: () => ({ type: 'events_api', payload: { event: { type: 'message', channel: ROUTED, ts: 'abc' } } }),
  },
  {
    name: 'event with a three-part ts',
    body: () => ({ type: 'events_api', payload: { event: { type: 'message', channel: ROUTED, ts: '1.2.3' } } }),
  },
  {
    name: 'event with a numeric channel',
    body: (fake) => ({ type: 'events_api', payload: { event: { type: 'message', channel: 42, ts: fake.mintTs() } } }),
  },
  {
    name: 'event with no channel',
    body: (fake) => ({ type: 'events_api', payload: { event: { type: 'message', ts: fake.mintTs() } } }),
  },
  {
    name: 'event with a numeric subtype',
    body: (fake) => ({
      type: 'events_api',
      payload: { event: { type: 'message', channel: ROUTED, ts: fake.mintTs(), subtype: 123 } },
    }),
  },
  {
    name: 'event with a non-message type',
    body: (fake) => ({
      type: 'events_api',
      payload: { event: { type: 'reaction_added', channel: ROUTED, ts: fake.mintTs() } },
    }),
  },
  {
    name: 'a dropped subtype on a routed channel',
    body: (fake) => ({
      type: 'events_api',
      payload: {
        event: { type: 'message', channel: ROUTED, ts: fake.mintTs(), text: 'joined', subtype: 'channel_join' },
      },
    }),
  },
  {
    name: 'a plain message on an UNROUTED channel',
    body: (fake) => ({
      type: 'events_api',
      payload: { event: { type: 'message', channel: UNROUTED, ts: fake.mintTs(), text: 'elsewhere' } },
    }),
  },
  { name: 'an unknown envelope type', body: () => ({ type: 'slash_commands', payload: {} }) },
  { name: 'an envelope with no type at all', body: () => ({ payload: { event: null } }) },
];

interface Harness {
  fake: FakeSlack;
  plugin: SlackPlugin;
  topic: Topic;
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const fake = await FakeSlack.start();
  const plugin = new SlackPlugin();
  await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
  const topic = asTopic(ROUTED);
  fake.createChannel(topic);
  fake.createChannel(UNROUTED);
  return {
    fake,
    plugin,
    topic,
    cleanup: async () => {
      await plugin.disconnect();
      await fake.close();
    },
  };
}

/** Watch for the crash shape a throw inside `ws.on('message')` produces. */
function watchForCrashes(): { crashes: unknown[]; stop: () => void } {
  const crashes: unknown[] = [];
  const onCrash = (e: unknown): void => {
    crashes.push(e);
  };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  return {
    crashes,
    stop: () => {
      process.off('uncaughtException', onCrash);
      process.off('unhandledRejection', onCrash);
    },
  };
}

describe('slack socket mode: untrusted envelopes', () => {
  it('with a route registered: every dropped envelope is acked, nothing surfaces, nothing crashes', async () => {
    const h = await harness();
    const watch = watchForCrashes();
    try {
      const live: Message[] = [];
      await h.plugin.subscribe(h.topic, (m) => live.push(m));

      const ids = new Map<string, string>();
      for (const row of DROPPED) ids.set(row.name, h.fake.pushEnvelope(row.body(h.fake)));

      // A well-formed push AFTER the whole table: proves the socket is still serving.
      await h.plugin.post(h.topic, asHandle('writer'), 'still alive');
      await vi.waitFor(() => expect(live.map((m) => m.content)).toEqual(['still alive']), {
        timeout: 3000,
        interval: 10,
      });
      await vi.waitFor(
        () => {
          for (const [name, id] of ids) expect(h.fake.acked, `unacked: ${name}`).toContain(id);
        },
        { timeout: 3000, interval: 10 },
      );
      expect(live.map((m) => m.content)).toEqual(['still alive']);
      expect(watch.crashes).toEqual([]);
    } finally {
      watch.stop();
      await h.cleanup();
    }
  });

  it('with a blocking fetch parked and NO route: the same table neither crashes nor loses the wake', async () => {
    const h = await harness();
    const watch = watchForCrashes();
    try {
      const parked = h.plugin.fetchRecent({ topic: h.topic, since: asCursor('0'), blockMs: 4000 });
      // Let the waiter arm (handshake + gap-closing re-query) before the table lands.
      await new Promise((r) => setTimeout(r, 250));

      const ids = new Map<string, string>();
      for (const row of DROPPED) ids.set(row.name, h.fake.pushEnvelope(row.body(h.fake)));

      const [created] = h.fake.seed(h.topic, [{ text: 'wakes it' }]);
      h.fake.pushEvent(h.topic, { ts: created!.ts, text: 'wakes it', user: 'U0PARLEY' });

      const result = await parked;
      expect(result.messages.map((m) => m.content)).toEqual(['wakes it']);
      for (const [name, id] of ids) expect(h.fake.acked, `unacked: ${name}`).toContain(id);
      expect(watch.crashes).toEqual([]);
    } finally {
      watch.stop();
      await h.cleanup();
    }
  });

  it('a throwing handler still gets its envelope acked', async () => {
    const h = await harness();
    try {
      await h.plugin.subscribe(h.topic, () => {
        throw new Error('handler exploded');
      });
      await h.plugin.post(h.topic, asHandle('writer'), 'boom');
      await vi.waitFor(
        () => {
          expect(h.fake.pushed.size).toBeGreaterThan(0);
          for (const id of h.fake.pushed) expect(h.fake.acked).toContain(id);
        },
        { timeout: 3000, interval: 10 },
      );
    } finally {
      await h.cleanup();
    }
  });

  it('a `disconnect` envelope is acked before the socket is rotated out', async () => {
    const h = await harness();
    try {
      const live: Message[] = [];
      await h.plugin.subscribe(h.topic, (m) => live.push(m));
      const id = h.fake.pushEnvelope({ type: 'disconnect', reason: 'refresh_requested' });

      await vi.waitFor(() => expect(h.fake.acked).toContain(id), { timeout: 3000, interval: 10 });
      // …and the plugin re-establishes, so live delivery resumes on the fresh connection.
      await vi.waitFor(() => expect(h.fake.liveSockets).toBeGreaterThan(0), {
        timeout: 4000,
        interval: 10,
      });
      await h.plugin.post(h.topic, asHandle('writer'), 'after rotate');
      await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('after rotate'), {
        timeout: 4000,
        interval: 10,
      });
    } finally {
      await h.cleanup();
    }
  });
});
