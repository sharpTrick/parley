/**
 * The constraints a real Zulip enforces that a permissive fake would hide: a hard per-request page
 * cap, a 60-character subject that is silently truncated on send, case-folded topic matching, and
 * credentials that must belong to a real account. The fake models each one
 * ({@link SERVER_CONSTRAINTS}), so these tables fail here exactly as they would fail live.
 */
import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { type FakeMember, SERVER_CONSTRAINTS } from './fake-zulip.js';
import { rand, SENDER, useZulip } from './harness.js';

const boot = useZulip();

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

/**
 * Zulip truncates a subject by PYTHON character — a code point — and the plugin case-folds before
 * measuring, so both the count and the fold are load-bearing. An ASCII-only table cannot see either:
 * every ASCII string has the same length in code points and UTF-16 units, and ASCII folding never
 * changes a string's length. Each unit below is exactly one code point, so `unit.repeat(n)` is an
 * n-code-point topic whatever the script.
 */
const CHARSETS = [
  { name: 'ASCII', unit: 'a' },
  { name: 'Latin-1 accented', unit: 'é' },
  { name: 'CJK', unit: '中' },
  { name: 'astral emoji', unit: '\u{1F600}' },
  { name: 'U+0130, which folds to TWO code points', unit: 'İ' },
  { name: 'U+00DF, which folds to itself', unit: 'ß' },
  { name: 'U+0131 dotless i', unit: 'ı' },
];

/** What the plugin must measure: code points of the topic AFTER folding, which is what Zulip sees. */
const wireLength = (topic: string): number => [...topic.toLowerCase()].length;

describe('zulip topic length vs the server truncation, counted in code points', () => {
  const max = SERVER_CONSTRAINTS.maxTopicNameLength;
  for (const charset of CHARSETS) {
    for (const codePoints of [1, max - 1, max, max + 1]) {
      const topic = asTopic(charset.unit.repeat(codePoints));
      const onWire = wireLength(topic);
      const verdict = onWire > max ? 'is rejected, naming the wire count' : 'round-trips exactly';
      it(`${codePoints} × ${charset.name} (${onWire} on the wire) ${verdict}`, async () => {
        const { plugin } = await boot();
        if (onWire > max) {
          for (const call of [
            plugin.post(topic, SENDER, 'x'),
            plugin.fetchRecent({ topic }),
            plugin.subscribe(topic, () => undefined),
          ]) {
            await expect(call).rejects.toThrow(`${onWire} characters`);
          }
          return;
        }
        await plugin.post(topic, SENDER, 'x');
        const { messages } = await plugin.fetchRecent({ topic });
        expect(messages.map((m) => m.content)).toEqual(['x']);
        expect(messages[0]?.topic).toBe(topic);
      });
    }
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

/**
 * Case pairs in scripts where JS folding and the server's folding could disagree. The pairs that do
 * NOT collide matter as much as the ones that do: `İ`/`i` and `ß`/`SS` look like case variants and
 * are not, so treating them as one topic would merge two histories that the server keeps apart.
 */
const CASE_PAIRS = [
  { first: 'ops', variant: 'OPS', collides: true },
  { first: 't', variant: 'T', collides: true },
  { first: 'Alpha', variant: 'alpha', collides: true },
  { first: 'Design Review', variant: 'design review', collides: true },
  { first: 'École', variant: 'école', collides: true },
  { first: 'ΑΡΕΤΗ', variant: 'αρετη', collides: true },
  { first: 'АЛФА', variant: 'алфа', collides: true },
  { first: 'İstanbul', variant: 'istanbul', collides: false },
  { first: 'Straße', variant: 'STRASSE', collides: false },
];

describe('zulip topic case folding vs the topic allowlist', () => {
  for (const { first, variant, collides } of CASE_PAIRS) {
    const verdict = collides
      ? 'is refused — they would share one Zulip history'
      : 'is a SEPARATE topic — the server does not fold them together';
    it(`${JSON.stringify(variant)} after ${JSON.stringify(first)} ${verdict}`, async () => {
      const { plugin } = await boot();
      const suffix = rand();
      const a = asTopic(`${first}-${suffix}`);
      const b = asTopic(`${variant}-${suffix}`);
      await plugin.post(a, SENDER, 'x');

      if (!collides) {
        await plugin.post(b, SENDER, 'y');
        expect((await plugin.fetchRecent({ topic: a })).messages.map((m) => m.content)).toEqual(['x']);
        expect((await plugin.fetchRecent({ topic: b })).messages.map((m) => m.content)).toEqual(['y']);
        return;
      }
      await expect(plugin.post(b, SENDER, 'y')).rejects.toThrow(/collision/i);
      await expect(plugin.fetchRecent({ topic: b })).rejects.toThrow(/collision/i);
      await expect(plugin.subscribe(b, () => undefined)).rejects.toThrow(/collision/i);
      const { messages } = await plugin.fetchRecent({ topic: a });
      expect(messages.map((m) => m.content)).toEqual(['x']);
    });
  }

  /**
   * Which call touches a variant FIRST decides nothing about who owns the wire name: only a WRITE
   * claims it. A read addresses history it did not create, so a read of a variant — a topic name the
   * model chooses, which a widened `post_topics` pattern need not have configured — must never be
   * able to disable the configured topic's own writes for the life of the process.
   */
  const PATHS = ['post', 'subscribe', 'fetchRecent'] as const;
  const touch = async (
    plugin: Awaited<ReturnType<typeof boot>>['plugin'],
    path: (typeof PATHS)[number],
    topic: ReturnType<typeof asTopic>,
  ): Promise<void> => {
    if (path === 'post') await plugin.post(topic, SENDER, 'x');
    else if (path === 'subscribe') await plugin.subscribe(topic, () => undefined);
    else await plugin.fetchRecent({ topic });
  };
  const CLAIMS: Record<(typeof PATHS)[number], boolean> = {
    post: true,
    subscribe: true,
    fetchRecent: false,
  };

  for (const first of PATHS) {
    for (const second of PATHS) {
      const verdict = CLAIMS[first] ? 'is refused' : 'still works';
      it(`${second} on the configured topic after ${first} on a case variant ${verdict}`, async () => {
        const { plugin } = await boot();
        const configured = asTopic(`tmp-a-${rand()}`);
        const variant = asTopic(configured.toUpperCase());

        await touch(plugin, first, variant);
        const call = touch(plugin, second, configured);
        if (CLAIMS[first]) {
          await expect(call).rejects.toThrow(/collision/i);
          return;
        }
        await call;
        await plugin.post(configured, SENDER, 'y');
        expect((await plugin.fetchRecent({ topic: configured })).messages.at(-1)?.content).toBe('y');
      });
    }
  }

  it('a read of many case variants leaves every configured topic writable', async () => {
    const { plugin } = await boot();
    const configured = Array.from({ length: 40 }, () => asTopic(`bulk-${rand()}`));
    for (const topic of configured) await plugin.fetchRecent({ topic: asTopic(topic.toUpperCase()) });
    for (const topic of configured) await plugin.post(topic, SENDER, 'x');
    for (const topic of configured) {
      expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual(['x']);
    }
  });

  for (const script of ['ops', 'αρετη', 'алфа']) {
    it(`a third party's upper-case ${JSON.stringify(script)} lands in the SAME Parley topic`, async () => {
      const { plugin, fake } = await boot();
      const topic = asTopic(`${script}-${rand()}`);
      await plugin.post(topic, SENDER, 'ours');
      fake.injectMessage({ topic: topic.toUpperCase(), content: 'theirs' });

      const { messages } = await plugin.fetchRecent({ topic });
      expect(messages.map((m) => m.content)).toEqual(['ours', 'theirs']);
      expect(messages.map((m) => m.topic)).toEqual([topic, topic]);
    });
  }
});

describe('zulip credentials', () => {
  it('a wrong api_key fails loudly on first use rather than reading as an empty topic', async () => {
    const { plugin } = await boot(undefined, { api_key: 'not-the-bots-key' });
    await expect(plugin.fetchRecent({ topic: asTopic(`auth-${rand()}`) })).rejects.toThrow('401');
  });
});

/**
 * A realm laid out so every cell of {@link RESOLUTIONS} has a carrier: the deactivated member is
 * always listed FIRST in its pair, so a resolution that forgets the `is_active` filter picks the
 * stale account rather than failing on ordering luck.
 */
const DIRECTORY: FakeMember[] = [
  { user_id: 10, email: 'parley-bot@localhost', full_name: 'Parley Bot', is_bot: true },
  { user_id: 13, email: 'sole@example.com', full_name: 'Sole Match' },
  { user_id: 42, email: 'impostor@example.com', full_name: 'Pat Sharp' },
  { user_id: 11, email: 'pat@example.com', full_name: 'Pat Sharp' },
  { user_id: 44, email: 'dupe@example.com', full_name: 'Dupe One' },
  { user_id: 45, email: 'dupe@example.com', full_name: 'Dupe Two' },
  { user_id: 12, email: 'gone@example.com', full_name: 'Gone Away', is_active: false },
  { user_id: 47, email: 'shared@example.com', full_name: 'Shared Gone', is_active: false },
  { user_id: 46, email: 'shared@example.com', full_name: 'Shared Live' },
  { user_id: 48, email: 'ghost@example.com', full_name: 'Twin Name', is_active: false },
  { user_id: 49, email: 'twin@example.com', full_name: 'Twin Name' },
];

/**
 * Every resolution branch × every directory hazard. A handle resolves to a `user_id` only when
 * exactly ONE active member carries it; everything else degrades to the string convention, because
 * handing back the wrong `user_id` lets one participant address another's account.
 */
const HAZARDS: Array<{
  hazard: string;
  email: { handle: string; expected: string };
  fullName: { handle: string; expected: string };
}> = [
  {
    hazard: 'the sole active carrier',
    email: { handle: 'pat@example.com', expected: '11' },
    fullName: { handle: 'Sole Match', expected: '13' },
  },
  {
    hazard: 'carried by two active members',
    email: { handle: 'dupe@example.com', expected: 'dupe@example.com' },
    fullName: { handle: 'Pat Sharp', expected: 'Pat Sharp' },
  },
  {
    hazard: 'carried only by a deactivated member',
    email: { handle: 'gone@example.com', expected: 'gone@example.com' },
    fullName: { handle: 'Gone Away', expected: 'Gone Away' },
  },
  {
    hazard: 'carried by one active and one deactivated member',
    email: { handle: 'shared@example.com', expected: '46' },
    fullName: { handle: 'Twin Name', expected: '49' },
  },
  {
    hazard: 'carried by nobody',
    email: { handle: 'nobody@example.com', expected: 'nobody@example.com' },
    fullName: { handle: 'Nobody At All', expected: 'Nobody At All' },
  },
];

const RESOLUTIONS = HAZARDS.flatMap((row) => [
  { branch: 'email', hazard: row.hazard, ...row.email },
  { branch: 'full_name', hazard: row.hazard, ...row.fullName },
]);

describe('zulip resolveIdentity never picks among ambiguous or stale candidates', () => {
  for (const row of RESOLUTIONS) {
    it(`a handle that is ${row.branch} ${row.hazard} → ${row.expected}`, async () => {
      const { plugin } = await boot({ members: DIRECTORY });
      expect(await plugin.resolveIdentity(asHandle(row.handle))).toEqual({
        handle: row.handle,
        backendRef: row.expected,
      });
    });
  }
});
