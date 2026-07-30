/**
 * CLASS: a fixture that grades the suite must itself be graded. Every rate-limit and poll-storm
 * ceiling in this package is written as `fake.hits(method) <= bound`, and every ack assertion reads
 * `fake.acked` — so a counter that misses the very requests under test, or an envelope the fake
 * invents an id for, turns a whole family of ceilings into decoration. `documented-scopes.test.ts`
 * uses the same pattern for its source extractors.
 */
import { describe, expect, it } from 'vitest';
import { FakeSlack } from './fake-slack.js';

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
