/**
 * Two CLASSES of input the plugin cannot trust:
 *
 * (1) CONFIG. A topic → channel map is many-to-one by construction. Two topics folding onto one
 *     channel is not a merge, it is a silent displacement: one topic's handler stops firing and
 *     that channel's traffic is delivered under the OTHER topic's name, crossing into a different
 *     topic's dedup and allowlist namespace. It must fail at load, naming both topics.
 *
 * (2) HISTORY. One unexpected record in a `conversations.history` page must not reject the call and
 *     must not mint an empty `backendMsgId`/`cursor` — an empty dedup key collapses every message
 *     that carries it, and a rejection that repeats on every catch-up wedges the topic forever,
 *     because the cursor never advances past the record that caused it.
 */
import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';

const COLLIDING: Array<{ name: string; map: Record<string, string>; topics: [string, string] }> = [
  {
    name: 'two mapped topics on one channel',
    map: { alpha: 'C0SHARED', beta: 'C0SHARED' },
    topics: ['alpha', 'beta'],
  },
  {
    name: 'three mapped topics, two of them colliding',
    map: { alpha: 'C0A', beta: 'C0SHARED', gamma: 'C0SHARED' },
    topics: ['beta', 'gamma'],
  },
  {
    name: 'a topic mapped to the channel another topic is named after',
    map: { alpha: 'C0LITERAL', C0LITERAL: 'C0LITERAL' },
    topics: ['alpha', 'C0LITERAL'],
  },
];

describe('slack colliding topic → channel mappings', () => {
  for (const row of COLLIDING) {
    it(`connect rejects ${row.name}, naming both topics`, async () => {
      const plugin = new SlackPlugin();
      await expect(
        plugin.connect({ api_url: 'http://127.0.0.1:1/api', channel_map: row.map }),
      ).rejects.toThrow(new RegExp(`${row.topics[0]}[\\s\\S]*${row.topics[1]}`));
    });
  }

  it('accepts a map whose targets are distinct, including near-miss ids', async () => {
    const plugin = new SlackPlugin();
    await plugin.connect({
      api_url: 'http://127.0.0.1:1/api',
      channel_map: { alpha: 'C0AAA', beta: 'C0AAB', gamma: 'c0aaa' },
    });
    await plugin.disconnect();
  });

  /**
   * A mapped topic and an unmapped channel-id literal collide only at USE, so the guard has to live
   * on every seam method, not just `subscribe`. The documented chat default runs with live push OFF
   * and never calls `subscribe` at all, so a guard that only exists there leaves the reactive
   * deployment — the common one — silently running two topics over one channel.
   */
  const ENTRY_POINTS: Array<{ name: string; use: (p: SlackPlugin, t: Topic) => Promise<unknown> }> = [
    { name: 'subscribe', use: (p, t) => p.subscribe(t, () => undefined) },
    { name: 'post', use: (p, t) => p.post(t, asHandle('writer'), 'meant for the other topic') },
    { name: 'fetchRecent', use: (p, t) => p.fetchRecent({ topic: t, limit: 10 }) },
    {
      name: 'fetchRecent-since',
      use: (p, t) => p.fetchRecent({ topic: t, since: asCursor('0'), limit: 10 }),
    },
  ];

  for (const first of ENTRY_POINTS) {
    for (const second of ENTRY_POINTS) {
      it(`${second.name} rejects the aliasing topic after ${first.name} claimed the channel`, async () => {
        const fake = await FakeSlack.start();
        const plugin = new SlackPlugin();
        await plugin.connect({
          api_url: fake.apiUrl,
          bot_token: 'xoxb-test',
          app_token: 'xapp-test',
          channel_map: { alpha: 'C0LIT' },
        });
        fake.createChannel('C0LIT');
        try {
          await first.use(plugin, asTopic('alpha'));
          // `C0LIT` is unmapped, so it is used as a channel-id literal — `alpha`'s channel.
          await expect(second.use(plugin, asTopic('C0LIT'))).rejects.toThrow(
            /alpha[\s\S]*C0LIT|C0LIT[\s\S]*alpha/,
          );
          // …and the owning topic still works: the rejection displaced nothing.
          await plugin.post(asTopic('alpha'), asHandle('writer'), 'kept');
          const { messages } = await plugin.fetchRecent({ topic: asTopic('alpha'), limit: 10 });
          expect(messages.at(-1)?.content).toBe('kept');
        } finally {
          await plugin.disconnect();
          await fake.close();
        }
      });
    }
  }

  it('subscribe keeps the first topic live after rejecting the aliasing one', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    await plugin.connect({
      api_url: fake.apiUrl,
      bot_token: 'xoxb-test',
      app_token: 'xapp-test',
      channel_map: { alpha: 'C0LIT' },
    });
    fake.createChannel('C0LIT');
    try {
      const received: Array<{ topic: string; content: string }> = [];
      await plugin.subscribe(asTopic('alpha'), (m) =>
        received.push({ topic: String(m.topic), content: m.content }),
      );
      await expect(plugin.subscribe(asTopic('C0LIT'), () => undefined)).rejects.toThrow(/alpha/);

      // The first topic's route is intact: the rejected subscribe did not displace it.
      await plugin.post(asTopic('alpha'), asHandle('writer'), 'kept');
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3000, interval: 10 });
      expect(received[0]).toEqual({ topic: 'alpha', content: 'kept' });
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });
});

/**
 * One bad record, at each position it can occupy in a page, with and without a `since`.
 * `surfacesAs` names the rows that are legitimately deliverable — a subtype-less entry with a
 * well-formed `ts` IS a message, however odd its text — so the table states which is which rather
 * than letting "it did not crash" stand in for "it was classified correctly".
 */
const BAD_ENTRIES: Array<{ name: string; entry: unknown; surfacesAs?: string }> = [
  { name: 'no ts', entry: { type: 'message', text: 'bad', user: 'U0' } },
  { name: 'null ts', entry: { type: 'message', ts: null, text: 'bad', user: 'U0' } },
  { name: 'numeric ts', entry: { type: 'message', ts: 42, text: 'bad', user: 'U0' } },
  { name: 'empty ts', entry: { type: 'message', ts: '', text: 'bad', user: 'U0' } },
  { name: 'non-numeric ts', entry: { type: 'message', ts: 'abc', text: 'bad', user: 'U0' } },
  { name: 'three-part ts', entry: { type: 'message', ts: '1.2.3', text: 'bad', user: 'U0' } },
  {
    name: 'float-shaped ts as a JSON number',
    entry: { type: 'message', ts: 1700000000.1, text: 'bad' },
  },
  { name: 'null entry', entry: null },
  { name: 'no type', entry: { ts: '1700000000.000001', text: 'bad', user: 'U0' } },
  {
    name: 'null text',
    entry: { type: 'message', ts: '1700000000.000002', text: null, user: 'U0' },
    surfacesAs: '',
  },
  // RANGE, not shape: these match `\d+\.\d+` and reach `new Date(seconds * 1000)`, which THROWS
  // outside the Date range — a rejection the cursor can never advance past, i.e. a wedged topic.
  {
    name: 'ts seconds past the Date range',
    entry: { type: 'message', ts: '99999999999999999.000001', text: 'poison', user: 'U0' },
  },
  {
    name: 'ts with 400 seconds digits',
    entry: { type: 'message', ts: `${'9'.repeat(400)}.000001`, text: 'poison', user: 'U0' },
  },
  {
    name: 'ts with 400 suffix digits',
    entry: { type: 'message', ts: `1700000000.${'9'.repeat(400)}`, text: 'poison', user: 'U0' },
  },
  // IDENTITY, not shape: `senderHandle` must never be minted empty — the seam's own
  // well-formedness rule forbids it and core's identity filter and roster read it directly.
  {
    name: 'no user and no bot_id',
    entry: { type: 'message', ts: '1700000000.000003', text: 'ghost' },
    surfacesAs: 'ghost',
  },
  {
    name: 'null user, null bot_id',
    entry: { type: 'message', ts: '1700000000.000004', text: 'ghost', user: null, bot_id: null },
    surfacesAs: 'ghost',
  },
  {
    name: 'empty-string user',
    entry: { type: 'message', ts: '1700000000.000005', text: 'ghost', user: '' },
    surfacesAs: 'ghost',
  },
  {
    name: 'bot_id only',
    entry: { type: 'message', ts: '1700000000.000006', text: 'app post', bot_id: 'B0APP' },
    surfacesAs: 'app post',
  },
];

const POSITIONS = ['only', 'first', 'middle', 'last'] as const;

async function seedWithBadEntry(
  fake: FakeSlack,
  topic: Topic,
  entry: unknown,
  position: (typeof POSITIONS)[number],
): Promise<string[]> {
  if (position === 'only') {
    fake.seedRaw(topic, [entry]);
    return [];
  }
  const before = position === 'first' ? 0 : position === 'middle' ? 2 : 4;
  const after = 4 - before;
  const good: string[] = [];
  if (before > 0) {
    good.push(...fake.seed(topic, Array.from({ length: before }, (_, i) => ({ text: `g${i}` }))).map((m) => m.text));
  }
  fake.seedRaw(topic, [entry]);
  if (after > 0) {
    good.push(
      ...fake
        .seed(topic, Array.from({ length: after }, (_, i) => ({ text: `h${i}` })))
        .map((m) => m.text),
    );
  }
  return good;
}

describe('slack history robustness: one hostile record must not wedge catch-up', () => {
  for (const bad of BAD_ENTRIES) {
    it(`survives a page containing an entry with ${bad.name}`, async () => {
      const fake = await FakeSlack.start();
      const plugin = new SlackPlugin();
      await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test' });
      try {
        for (const position of POSITIONS) {
          for (const withSince of [false, true]) {
            const topic = asTopic(`C0BAD${position}${withSince ? 'S' : ''}`);
            fake.createChannel(topic);
            const good = await seedWithBadEntry(fake, topic, bad.entry, position);

            const result = await plugin.fetchRecent(
              withSince ? { topic, since: asCursor('0'), limit: 100 } : { topic, limit: 100 },
            );

            // The bad entry's `ts` is always older than the fake's freshly minted ones, so a row
            // that legitimately surfaces lands ahead of the good entries.
            const expected = bad.surfacesAs === undefined ? good : [bad.surfacesAs, ...good];
            const where = `${bad.name} @${position} since=${withSince}`;
            expect(result.messages.map((m) => m.content), where).toEqual(expected);
            for (const m of result.messages) {
              expect(String(m.backendMsgId).length, where).toBeGreaterThan(0);
              expect(String(m.cursor).length, where).toBeGreaterThan(0);
              expect(String(m.senderHandle).length, where).toBeGreaterThan(0);
            }
            expect(String(result.nextCursor).length, where).toBeGreaterThan(0);
          }
        }
      } finally {
        await plugin.disconnect();
        await fake.close();
      }
    });
  }
});

/**
 * CLASS: a field that passes the SHAPE guard but not the RANGE guard. The fixed table above names
 * the widths someone thought of; this generates every `ts` the accepted shape admits — including
 * the widths nobody thought of — and asserts the normalize path neither throws nor loses ground.
 */
const TS_WIDTHS = [1, 2, 9, 10, 11, 12, 13, 17, 40, 400];

describe('slack ts range: every string the shape guard admits must normalize', () => {
  const generated = TS_WIDTHS.flatMap((secs) =>
    TS_WIDTHS.map((sub) => `${'9'.repeat(secs)}.${'1'.repeat(sub)}`),
  );

  it('the generator only produces strings the shape guard would accept', () => {
    for (const ts of generated) expect(/^\d+\.\d+$/.test(ts)).toBe(true);
    expect(generated.length).toBe(TS_WIDTHS.length ** 2);
  });

  it('history: no generated ts rejects the call or rolls the cursor backwards', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test' });
    try {
      const topic = asTopic('C0TSGEN');
      const anchor = fake.seed(topic, [{ text: 'anchor' }])[0]!;
      fake.seedRaw(
        topic,
        generated.map((ts) => ({ type: 'message', ts, text: `gen-${ts.length}`, user: 'U0' })),
      );

      for (const since of [undefined, asCursor('0'), asCursor(anchor.ts)]) {
        const result = await plugin.fetchRecent(
          since === undefined ? { topic, limit: 100 } : { topic, since, limit: 100 },
        );
        expect(String(result.nextCursor).length).toBeGreaterThan(0);
        for (const m of result.messages) {
          expect(Number.isNaN(Date.parse(m.timestamp))).toBe(false);
          expect(String(m.senderHandle).length).toBeGreaterThan(0);
        }
      }
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });

  it('live push: no generated ts breaks the socket or reaches a handler unnormalized', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
    try {
      const topic = asTopic('C0TSLIVE');
      fake.createChannel(topic);
      const seen: string[] = [];
      await plugin.subscribe(topic, (m) => {
        expect(Number.isNaN(Date.parse(m.timestamp))).toBe(false);
        seen.push(m.content);
      });
      for (const ts of generated) {
        fake.pushEnvelope({
          type: 'events_api',
          payload: { event: { type: 'message', channel: topic, ts, text: `gen-${ts}`, user: 'U0' } },
        });
      }
      // The socket is still serving afterwards — an envelope that killed it would strand this.
      await plugin.post(topic, asHandle('writer'), 'still alive');
      await vi.waitFor(() => expect(seen).toContain('still alive'), { timeout: 3000, interval: 10 });
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });
});

describe('slack post: an ok:true reply is not a promise that `ts` is there', () => {
  const REPLIES: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: 'no ts at all', body: { ok: true, channel: 'C0X' } },
    { name: 'null ts', body: { ok: true, ts: null } },
    { name: 'numeric ts', body: { ok: true, ts: 1700000000.1 } },
    { name: 'empty ts', body: { ok: true, ts: '' } },
    { name: 'unparseable ts', body: { ok: true, ts: 'abc' } },
    { name: 'ts past the Date range', body: { ok: true, ts: '99999999999999999.000001' } },
  ];

  for (const reply of REPLIES) {
    it(`rejects rather than branding an unusable dedup key: ${reply.name}`, async () => {
      const { createServer } = await import('node:http');
      const server = createServer((req, res) => {
        void (async () => {
          for await (const _ of req) void _;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(reply.body));
        })();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address() as { port: number };
      const plugin = new SlackPlugin();
      try {
        await plugin.connect({ api_url: `http://127.0.0.1:${port}/api`, bot_token: 'xoxb-test' });
        await expect(plugin.post(asTopic('C0X'), asHandle('writer'), 'hi')).rejects.toThrow(
          /no usable ts/,
        );
      } finally {
        await plugin.disconnect();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  }
});
