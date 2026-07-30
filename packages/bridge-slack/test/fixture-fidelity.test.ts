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
 */
import { asCursor, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { HISTORY_PAGE_LIMIT } from '../src/index.js';
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
        expect(fake.historyRequests).toHaveLength(pages);
        for (const [i, request] of fake.historyRequests.entries()) {
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
