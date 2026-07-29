/**
 * The constraints a real Zulip enforces that a permissive fake would hide: a hard per-request page
 * cap, a 60-character subject that is silently truncated on send, case-folded topic matching, and
 * credentials that must belong to a real account. The fake models each one
 * ({@link SERVER_CONSTRAINTS}), so these tables fail here exactly as they would fail live.
 */
import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ZulipPlugin } from '../src/index.js';
import { type FakeMember, type FakeZulip, SERVER_CONSTRAINTS, startFakeZulip } from './fake-zulip.js';

const rand = (): string => Math.random().toString(36).slice(2, 8);
const SENDER = asHandle('writer');

let open: Array<{ plugin: ZulipPlugin; fake: FakeZulip }> = [];

afterEach(async () => {
  for (const { plugin, fake } of open) {
    await plugin.disconnect().catch(() => undefined);
    await fake.close();
  }
  open = [];
});

async function boot(opts?: Parameters<typeof startFakeZulip>[0], config?: Record<string, unknown>) {
  const fake = await startFakeZulip(opts);
  const plugin = new ZulipPlugin();
  await plugin.connect({ site_url: fake.url, events_timeout_ms: 500, ...config });
  const pair = { plugin, fake };
  open.push(pair);
  return pair;
}

describe('zulip page size vs the server maximum', () => {
  const cap = SERVER_CONSTRAINTS.maxMessagesPerFetch;
  for (const limit of [1, 3, 12, 100, cap, cap + 1, 10_000, 50_000]) {
    it(`fetchRecent(limit: ${limit}) returns min(limit, available), never a page-cap error`, async () => {
      const { plugin } = await boot();
      const topic = asTopic(`page-${rand()}`);
      const all = Array.from({ length: 12 }, (_, i) => `m${i}`);
      for (const c of all) await plugin.post(topic, SENDER, c);

      const { messages } = await plugin.fetchRecent({ topic, limit });
      expect(messages.map((m) => m.content)).toEqual(all.slice(-Math.min(limit, all.length)));
    });
  }

  it('paginates transparently past the cap, ascending, in both read directions', async () => {
    const { plugin, fake } = await boot();
    const topic = asTopic(`page-big-${rand()}`);
    const total = SERVER_CONSTRAINTS.maxMessagesPerFetch + 100;
    for (let i = 0; i < total; i++) fake.injectMessage({ topic, content: `m${i}` });

    const recent = await plugin.fetchRecent({ topic, limit: total + 500 });
    expect(recent.messages).toHaveLength(total);
    expect(recent.messages[0]?.content).toBe('m0');
    expect(recent.messages.at(-1)?.content).toBe(`m${total - 1}`);
    const ids = recent.messages.map((m) => Number(m.cursor));
    expect(ids.every((id, i) => i === 0 || id > ids[i - 1]!)).toBe(true);

    const drained = await plugin.fetchRecent({ topic, since: asCursor('0'), limit: total + 500 });
    expect(drained.messages.map((m) => m.content)).toEqual(recent.messages.map((m) => m.content));
  });
});

describe('zulip topic length vs the server truncation', () => {
  const max = SERVER_CONSTRAINTS.maxTopicNameLength;
  for (const length of [1, max - 1, max, max + 1, 200]) {
    it(`a ${length}-character topic either round-trips exactly or is rejected`, async () => {
      const { plugin } = await boot();
      const topic = asTopic('a'.repeat(length));
      if (length > max) {
        await expect(plugin.post(topic, SENDER, 'x')).rejects.toThrow(String(max));
        await expect(plugin.fetchRecent({ topic })).rejects.toThrow(String(max));
        await expect(plugin.subscribe(topic, () => undefined)).rejects.toThrow(String(max));
        return;
      }
      await plugin.post(topic, SENDER, 'x');
      const { messages } = await plugin.fetchRecent({ topic });
      expect(messages.map((m) => m.content)).toEqual(['x']);
      expect(messages[0]?.topic).toBe(topic);
    });
  }

  it('two over-long topics sharing a 57-character prefix never merge into one history', async () => {
    const { plugin } = await boot();
    const prefix = 'p'.repeat(57);
    const a = asTopic(`${prefix}-alpha-tail`);
    const b = asTopic(`${prefix}-beta-tail`);
    await expect(plugin.post(a, SENDER, 'from-a')).rejects.toThrow(String(max));
    await expect(plugin.post(b, SENDER, 'from-b')).rejects.toThrow(String(max));
  });
});

describe('zulip topic case folding vs the topic allowlist', () => {
  for (const [first, variant] of [
    ['ops', 'OPS'],
    ['t', 'T'],
    ['Alpha', 'alpha'],
    ['Design Review', 'design review'],
  ]) {
    it(`refuses ${JSON.stringify(variant)} once ${JSON.stringify(first)} is in use — one Zulip history`, async () => {
      const { plugin } = await boot();
      const suffix = rand();
      const a = asTopic(`${first}-${suffix}`);
      const b = asTopic(`${variant}-${suffix}`);
      await plugin.post(a, SENDER, 'x');
      await expect(plugin.post(b, SENDER, 'y')).rejects.toThrow(/collision/i);
      await expect(plugin.fetchRecent({ topic: b })).rejects.toThrow(/collision/i);
      await expect(plugin.subscribe(b, () => undefined)).rejects.toThrow(/collision/i);
      const { messages } = await plugin.fetchRecent({ topic: a });
      expect(messages.map((m) => m.content)).toEqual(['x']);
    });
  }

  it('a third party posting a case variant lands in the SAME Parley topic, not a hidden second one', async () => {
    const { plugin, fake } = await boot();
    const topic = asTopic(`ops-${rand()}`);
    await plugin.post(topic, SENDER, 'ours');
    fake.injectMessage({ topic: topic.toUpperCase(), content: 'theirs' });

    const { messages } = await plugin.fetchRecent({ topic });
    expect(messages.map((m) => m.content)).toEqual(['ours', 'theirs']);
    expect(messages.map((m) => m.topic)).toEqual([topic, topic]);
  });
});

describe('zulip credentials', () => {
  it('a wrong api_key fails loudly on first use rather than reading as an empty topic', async () => {
    const { plugin } = await boot(undefined, { api_key: 'not-the-bots-key' });
    await expect(plugin.fetchRecent({ topic: asTopic(`auth-${rand()}`) })).rejects.toThrow('401');
  });
});

const DIRECTORY: FakeMember[] = [
  { user_id: 10, email: 'parley-bot@localhost', full_name: 'Parley Bot', is_bot: true },
  { user_id: 42, email: 'impostor@example.com', full_name: 'Pat Sharp' },
  { user_id: 11, email: 'pat@example.com', full_name: 'Pat Sharp' },
  { user_id: 12, email: 'gone@example.com', full_name: 'Gone Away', is_active: false },
  { user_id: 13, email: 'sole@example.com', full_name: 'Sole Match' },
];

describe('zulip resolveIdentity never picks among ambiguous candidates', () => {
  for (const [name, handle, expected] of [
    ['an exact email match wins', 'pat@example.com', '11'],
    ['a full_name shared by two members is ambiguous', 'Pat Sharp', 'Pat Sharp'],
    ['a deactivated member is not a match', 'Gone Away', 'Gone Away'],
    ['a unique active full_name resolves', 'Sole Match', '13'],
    ['an unknown handle degrades to the string convention', 'nobody', 'nobody'],
  ]) {
    it(String(name), async () => {
      const { plugin } = await boot({ members: DIRECTORY });
      expect(await plugin.resolveIdentity(asHandle(String(handle)))).toEqual({
        handle,
        backendRef: expected,
      });
    });
  }
});
