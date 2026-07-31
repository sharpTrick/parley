/**
 * CLASS: a fixture that grades the suite must itself be graded. Every rate-limit and poll-storm
 * ceiling in this package is written as `fake.hits(method) <= bound`, and every ack assertion reads
 * `fake.acked` — so a counter that misses the very requests under test, or an envelope the fake
 * invents an id for, turns a whole family of ceilings into decoration. `documented-scopes.test.ts`
 * uses the same pattern for its source extractors.
 *
 * The same class covers a request PARAMETER the fixture ignores: a page size the fake serves
 * regardless of what was asked leaves the README's cost model gradeable only against the source
 * constant — a figure no request would then carry — so the parameters the history walk is built from
 * are asserted ON THE WIRE and against an observable page count.
 *
 * And the sharper form of it: a field the plugin puts on the wire that the fake DISCARDS. Every
 * assertion downstream then grades the plugin against a contract slack.com does not have, and reads
 * as coverage. `chat.postMessage`'s `thread_ts` was exactly that — deletable from the source with
 * the whole suite green — so the table below states, per seam call, both halves at once: the field
 * arrived, and the fixture ACTED on it.
 */
import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { HISTORY_PAGE_LIMIT, SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';
import { startSlack } from './harness.js';

const call = async (
  fake: FakeSlack,
  method: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> => {
  const res = await fetch(`${fake.apiUrl}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ channel: 'C0FIXTURE' }).toString(),
  });
  return (await res.json()) as { ok: boolean; error?: string };
};

describe('the fake counts every request that reached the wire', () => {
  // The missing-`app_token` configuration is exactly where an `apps.connections.open` storm is most
  // likely, and it is exactly the configuration whose calls carry no bearer token — so a counter
  // placed after the auth check scores that storm as ZERO.
  it.each(['apps.connections.open', 'conversations.history', 'chat.postMessage'])(
    'a token-less %s is answered not_authed AND counted',
    async (method) => {
      const fake = await FakeSlack.start();
      try {
        fake.createChannel('C0FIXTURE');
        expect(fake.hits(method)).toBe(0);
        const body = await call(fake, method, {});
        expect(body).toEqual({ ok: false, error: 'not_authed' });
        expect(fake.hits(method), 'reached the wire').toBe(1);
        expect(fake.unauthedHits(method), 'tracked separately').toBe(1);
      } finally {
        await fake.close();
      }
    },
  );

  it('an authenticated request is counted and does not count as unauthenticated', async () => {
    const fake = await FakeSlack.start();
    try {
      fake.createChannel('C0FIXTURE');
      const body = await call(fake, 'conversations.history', { Authorization: 'Bearer xoxb-test' });
      expect(body.ok).toBe(true);
      expect(fake.hits('conversations.history')).toBe(1);
      expect(fake.unauthedHits('conversations.history')).toBe(0);
    } finally {
      await fake.close();
    }
  });

  it('a request to a path the fake does not serve is not counted as a method hit', async () => {
    const fake = await FakeSlack.start();
    try {
      const res = await fetch(`${fake.apiUrl.replace('/api', '')}/nope`, { method: 'POST' });
      expect(((await res.json()) as { error?: string }).error).toBe('unknown_method');
      expect(fake.hits('nope')).toBe(0);
    } finally {
      await fake.close();
    }
  });
});

/** Tier caps around the plugin's own request: below it, at the default fake page, and above it. */
const TIER_PAGE_SIZES = [15, 50, 1000];
const SEEDED = 300;

describe('the history walk asks the wire for what the source claims', () => {
  for (const pageSize of TIER_PAGE_SIZES) {
    it(`serves min(${HISTORY_PAGE_LIMIT}, ${pageSize}) per page, and every request states its limit`, async () => {
      const topic = asTopic('C0WIRE');
      const { fake, plugin, cleanup } = await startSlack({
        pageSize,
        appToken: null,
        channels: [topic],
      });
      try {
        fake.seed(
          topic,
          Array.from({ length: SEEDED }, (_, i) => ({ text: `m${i}` })),
        );

        const { messages } = await plugin.fetchRecent({
          topic,
          since: asCursor('0'),
          limit: SEEDED,
        });

        expect(messages).toHaveLength(SEEDED);
        // The page the server actually served, observed as a request count rather than taken on
        // trust: a request that dropped or renamed `limit` falls to Slack's default of 100 and pages
        // more often.
        const pages = Math.ceil(SEEDED / Math.min(HISTORY_PAGE_LIMIT, pageSize));
        expect(fake.hits('conversations.history'), 'pages walked').toBe(pages);
        expect(fake.requestBodies('conversations.history')).toHaveLength(pages);
        for (const [i, request] of fake.requestBodies('conversations.history').entries()) {
          expect(request.limit, `page ${i} limit`).toBe(String(HISTORY_PAGE_LIMIT));
          expect(request.channel, `page ${i} channel`).toBe(String(topic));
          // `oldest` is the exclusive floor and must ride EVERY page of the walk, not just the first.
          expect(request.oldest, `page ${i} oldest`).toBe('0');
          expect(typeof request.cursor, `page ${i} cursor`).toBe(i === 0 ? 'undefined' : 'string');
        }
      } finally {
        await cleanup();
      }
    });
  }
});

const WIRE_TOPIC = asTopic('C0BODY');
const SENDER = asHandle('writer');

/**
 * Per seam call: the EXACT request body it must have put on the wire. Compared whole, so a field the
 * source stops sending and a field it starts sending both fail here — the assertion `thread_ts` had
 * nowhere to fail, because only `conversations.history` bodies were ever recorded.
 */
const WIRE_ROWS: Array<{
  name: string;
  method: string;
  drive: (plugin: SlackPlugin) => Promise<Record<string, string>>;
}> = [
  {
    name: 'post',
    method: 'chat.postMessage',
    drive: async (plugin) => {
      await plugin.post(WIRE_TOPIC, SENDER, 'plain');
      return { channel: String(WIRE_TOPIC), text: 'plain' };
    },
  },
  {
    name: 'post with inReplyTo',
    method: 'chat.postMessage',
    drive: async (plugin) => {
      const parent = await plugin.post(WIRE_TOPIC, SENDER, 'question');
      await plugin.post(WIRE_TOPIC, SENDER, 'answer', { inReplyTo: parent });
      return {
        channel: String(WIRE_TOPIC),
        text: 'answer',
        thread_ts: String(parent),
        reply_broadcast: 'true',
      };
    },
  },
  {
    name: 'fetchRecent from a cursor',
    method: 'conversations.history',
    drive: async (plugin) => {
      await plugin.fetchRecent({ topic: WIRE_TOPIC, since: asCursor('0') });
      return { channel: String(WIRE_TOPIC), limit: String(HISTORY_PAGE_LIMIT), oldest: '0' };
    },
  },
  {
    name: "subscribe's readability probe",
    method: 'conversations.history',
    drive: async (plugin) => {
      await plugin.subscribe(WIRE_TOPIC, () => undefined);
      return { channel: String(WIRE_TOPIC), limit: '1' };
    },
  },
];

describe('every argument the source states reaches the wire', () => {
  for (const row of WIRE_ROWS) {
    it(`${row.name} sends exactly the ${row.method} body it claims`, async () => {
      const { fake, plugin, cleanup } = await startSlack({ channels: [WIRE_TOPIC] });
      try {
        const expected = await row.drive(plugin);
        expect(fake.requestBodies(row.method).at(-1)).toEqual(expected);
      } finally {
        await cleanup();
      }
    });
  }
});

/**
 * …and the other half: a field the fixture RECORDS but does not act on grades the plugin against a
 * contract slack.com does not have. Driven over raw HTTP rather than through the plugin, so a row
 * states the vendor rule itself — whether `conversations.history` can see the post — independently
 * of which fields the plugin currently chooses to send.
 */
const postRaw = async (
  fake: FakeSlack,
  fields: Record<string, string>,
): Promise<{ ok: boolean; ts?: string }> => {
  const res = await fetch(`${fake.apiUrl}/chat.postMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Bearer xoxb-test',
    },
    body: new URLSearchParams({ channel: 'C0THREAD', ...fields }).toString(),
  });
  return (await res.json()) as { ok: boolean; ts?: string };
};

describe('the fake acts on the chat.postMessage fields it records', () => {
  it.each([
    ['a channel-level post', {}, true],
    ['a plain thread reply', { thread_ts: 'PARENT' }, false],
    ['a broadcast thread reply', { thread_ts: 'PARENT', reply_broadcast: 'true' }, true],
  ])('conversations.history returns %s: %s', async (_name, fields, visible) => {
    const fake = await FakeSlack.start();
    try {
      fake.createChannel('C0THREAD');
      const parent = await postRaw(fake, { text: 'question' });
      expect(parent.ok).toBe(true);
      const posted = await postRaw(fake, {
        text: 'answer',
        ...('thread_ts' in fields ? { ...fields, thread_ts: String(parent.ts) } : fields),
      });
      expect(posted.ok).toBe(true);

      const res = await fetch(`${fake.apiUrl}/conversations.history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Bearer xoxb-test',
        },
        body: new URLSearchParams({ channel: 'C0THREAD' }).toString(),
      });
      const { messages } = (await res.json()) as { messages: Array<{ ts: string }> };
      expect(messages.some((m) => m.ts === posted.ts)).toBe(visible);
    } finally {
      await fake.close();
    }
  });
});
