/**
 * The constraints a real Zulip enforces that a permissive fake would hide: a hard per-request page
 * cap, a 60-character subject that is silently truncated on send, case-folded topic matching, and
 * credentials that must belong to a real account. The fake models each one
 * ({@link SERVER_CONSTRAINTS}), so these tables fail here exactly as they would fail live.
 */
import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import {
  type FakeMember,
  type FakeZulip,
  normalizeBody,
  SERVER_CONSTRAINTS,
} from './fake-zulip.js';
import { ZulipPlugin } from '../src/index.js';
import { CANDIDATE_PADDINGS, padName, PLACEMENTS, rand, SENDER, useZulip } from './harness.js';

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
 * Characters a topic can be padded with, generated over the WHOLE whitespace code space
 * ({@link CANDIDATE_PADDINGS}) and split by whether the SEND strips them — each verdict read off the
 * server's own enumerated set rather than decided per row by hand. Every stripped one is a distinct
 * hazard because the candidate sets disagree in both directions: `String#trim` takes U+FEFF the
 * server keeps and leaves U+0085 the server takes, and Python's `str.strip()` takes U+001C-U+001F
 * this parser keeps. The kept rows are asserted as hard as the stripped ones — an over-eager strip
 * check turns a usable topic into a permanent `post` error.
 */
const TOPIC_PADDINGS: Array<{ name: string; pad: string; stripped: boolean }> =
  CANDIDATE_PADDINGS.map((pad) => ({
    name: padName(pad),
    pad,
    stripped: SERVER_CONSTRAINTS.stripsTopicEdges.includes(pad),
  }));

/**
 * CLASS: a topic the SEND would rewrite is write-only, because no read rewrites it the same way —
 * `topic_match_q` is `subject__iexact` and an event queue's narrow a bare `lower()` compare, both of
 * the operand exactly as sent. The truncation above is one such rewrite and had rows; the strip is
 * the other and had none, so a hand-off posted to `ctx-handoff ` reported a durable id and then read
 * back as an empty topic forever, while the collision registry — keyed on the name as SENT — never
 * saw that `ctx-handoff ` and `ctx-handoff` had become one Zulip history.
 */
describe('zulip topic padding vs the whitespace the server strips on send', () => {
  for (const padding of TOPIC_PADDINGS) {
    for (const placement of PLACEMENTS) {
      const verdict = padding.stripped
        ? 'is refused, naming the rewrite'
        : 'round-trips as its own topic';
      it(`${placement.name} ${padding.name} ${verdict}`, async () => {
        const { plugin } = await boot();
        const bare = asTopic(`pad-${rand()}`);
        const topic = asTopic(placement.pad(padding.pad, bare));

        if (padding.stripped) {
          for (const call of [
            plugin.post(topic, SENDER, 'x'),
            plugin.fetchRecent({ topic }),
            plugin.subscribe(topic, () => undefined),
          ]) {
            await expect(call).rejects.toThrow(/strips whitespace/i);
          }
          // The bare name must stay usable: the padded one claimed no wire topic on its way out.
          await plugin.post(bare, SENDER, 'bare');
          expect((await plugin.fetchRecent({ topic: bare })).messages.map((m) => m.content)).toEqual(
            ['bare'],
          );
          return;
        }
        await plugin.post(topic, SENDER, 'padded');
        await plugin.post(bare, SENDER, 'bare');
        expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual([
          'padded',
        ]);
        expect((await plugin.fetchRecent({ topic: bare })).messages.map((m) => m.content)).toEqual([
          'bare',
        ]);
      });
    }
  }

  it('a topic that is nothing but whitespace is refused rather than posted to the empty one', async () => {
    const { plugin } = await boot();
    const topic = asTopic('  \t ');
    await expect(plugin.post(topic, SENDER, 'x')).rejects.toThrow(/strips whitespace/i);
    await expect(plugin.fetchRecent({ topic })).rejects.toThrow(/strips whitespace/i);
  });

  it('a padded topic and its bare form never merge into one history', async () => {
    const { plugin } = await boot();
    const bare = asTopic(`merge-${rand()}`);
    await plugin.post(bare, SENDER, 'ours');
    await expect(plugin.post(asTopic(`${bare} `), SENDER, 'theirs')).rejects.toThrow(/whitespace/i);
    expect((await plugin.fetchRecent({ topic: bare })).messages.map((m) => m.content)).toEqual([
      'ours',
    ]);
  });

  /**
   * The server strips where the request is parsed and truncates in the view, so a name only the
   * padding pushes past the cap is a name the server stores whole. Reporting the length there would
   * name a truncation that never happens and hide the rewrite that does.
   */
  it('a name only its padding pushes past the cap is reported as the strip, not the truncation', async () => {
    const { plugin } = await boot();
    const atTheCap = 't'.repeat(SERVER_CONSTRAINTS.maxTopicNameLength);
    await expect(plugin.post(asTopic(`${atTheCap} `), SENDER, 'x')).rejects.toThrow(
      /strips whitespace/i,
    );
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

/**
 * CLASS: every server-side rewrite of a WRITE the plugin issues is modelled by the fake and graded
 * by a row here — `post` either round-trips the payload exactly or refuses it naming the constraint.
 * A rewrite the plugin lets through returns a message id for a message the server stored as
 * something else, which is the one answer the seam does not allow: the TOPIC rewrites had rows,
 * the BODY rewrites had none, and a 15 000-character hand-off was accepted and stored truncated.
 */
interface WriteRewrite {
  /** Which {@link SERVER_CONSTRAINTS} entries the row grades; every key must be claimed by one. */
  constraints: Array<keyof typeof SERVER_CONSTRAINTS>;
  name: string;
  /** A prior write on the base topic, so a row can grade a rewrite that needs a claim to exist. */
  claimsBaseFirst?: true;
  topic?: (base: Topic) => Topic;
  content: string;
  /** Absent = the payload must survive the round trip byte for byte. */
  refuses?: RegExp;
}

const MAX_BODY = SERVER_CONSTRAINTS.maxMessageLength;

const WRITE_REWRITES: WriteRewrite[] = [
  {
    constraints: ['maxTopicNameLength', 'topicTruncationSuffix'],
    name: 'a topic one code point past the cap',
    topic: () => asTopic('t'.repeat(SERVER_CONSTRAINTS.maxTopicNameLength + 1)),
    content: 'x',
    refuses: /61 characters/,
  },
  {
    constraints: ['maxTopicNameLength'],
    name: 'a topic exactly at the cap',
    topic: () => asTopic(`t${rand()}`.padEnd(SERVER_CONSTRAINTS.maxTopicNameLength, 'x')),
    content: 'x',
  },
  {
    constraints: ['foldsTopicCase'],
    name: 'a topic differing from a claimed one only in case',
    claimsBaseFirst: true,
    topic: (base) => asTopic(base.toUpperCase()),
    content: 'x',
    refuses: /collision/i,
  },
  {
    constraints: ['stripsTopicEdges'],
    name: 'a topic carrying whitespace the send would strip off it',
    topic: (base) => asTopic(`${base} `),
    content: 'x',
    refuses: /strips whitespace/i,
  },
  {
    constraints: ['maxMessageLength', 'bodyTruncationSuffix'],
    name: 'a body one code point past the cap',
    content: 'x'.repeat(MAX_BODY + 1),
    refuses: new RegExp(`${MAX_BODY + 1} characters`),
  },
  {
    constraints: ['maxMessageLength'],
    name: 'a body exactly at the cap',
    content: 'x'.repeat(MAX_BODY),
  },
  {
    constraints: ['maxMessageLength'],
    name: 'an astral body at the cap in code points but past it in UTF-16 units',
    content: '\u{1F600}'.repeat(MAX_BODY),
  },
  {
    constraints: ['stripsBodyEdges'],
    name: 'a body with trailing spaces',
    content: '  hand-off  ',
    refuses: /trailing whitespace/,
  },
  {
    constraints: ['stripsBodyEdges'],
    name: 'a body with a trailing newline',
    content: 'hand-off\n',
    refuses: /trailing whitespace/,
  },
  {
    constraints: ['stripsBodyEdges'],
    name: 'a body with a leading newline',
    content: '\nhand-off',
    refuses: /leading newline/,
  },
  {
    constraints: ['stripsBodyEdges'],
    name: 'a body with leading spaces, which the server keeps',
    content: '  hand-off',
  },
  {
    constraints: ['stripsBodyEdges'],
    name: 'a body whose interior whitespace is all the server leaves alone',
    content: 'hand\n\n  off\tdone',
  },
  {
    constraints: ['rejectsEmptyBody'],
    name: 'an empty body',
    content: '',
    refuses: /empty/,
  },
  {
    constraints: ['rejectsEmptyBody'],
    name: 'a whitespace-only body',
    content: '  \n\t ',
    refuses: /empty/,
  },
  {
    constraints: ['rejectsNulInBody'],
    name: 'a body carrying a NUL',
    content: 'hand\u0000off',
    refuses: /NUL/,
  },
];

const BOT_AUTH = `Basic ${Buffer.from('parley-bot@localhost:parley-api-key').toString('base64')}`;

/**
 * A send that goes around the plugin. Every rewrite the plugin refuses is a rewrite no plugin call
 * can reach any more, so the fake's model of it is graded here instead — on the wire, where a fake
 * that quietly went back to echoing what it was sent is visible.
 */
const rawSend = async (
  fake: FakeZulip,
  opts: { topic: string; to?: string; content?: string },
): Promise<Response> =>
  fetch(`${fake.url}/api/v1/messages`, {
    method: 'POST',
    headers: { Authorization: BOT_AUTH, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      type: 'stream',
      to: opts.to ?? 'parley',
      topic: opts.topic,
      content: opts.content ?? 'x',
    }).toString(),
  });

/** How many records the server shows for a narrow the plugin would refuse to spell. */
const rawReadCount = async (
  fake: FakeZulip,
  opts: { topic: string; stream?: string },
): Promise<number> => {
  const query = new URLSearchParams({
    narrow: JSON.stringify([
      { operator: 'stream', operand: opts.stream ?? 'parley' },
      { operator: 'topic', operand: opts.topic },
    ]),
    anchor: 'newest',
    num_before: '10',
    num_after: '0',
    apply_markdown: 'false',
  });
  const res = await fetch(`${fake.url}/api/v1/messages?${query}`, {
    headers: { Authorization: BOT_AUTH },
  });
  return ((await res.json()) as { messages: unknown[] }).messages.length;
};

/** Constraints that govern a READ or the transport rather than a write, and where each is graded. */
const NON_WRITE_CONSTRAINTS: Record<string, string> = {
  maxMessagesPerFetch: 'the page-size table at the top of this file',
  requiresValidCredentials: 'the credentials case below',
  requestFlagDefaults: 'wire-format-flags.test.ts',
};

describe('zulip post never lets the server rewrite a write', () => {
  for (const row of WRITE_REWRITES) {
    const verdict = row.refuses === undefined ? 'round-trips exactly' : 'is refused, naming the constraint';
    it(`${row.name} ${verdict}`, async () => {
      const { plugin } = await boot();
      const base = asTopic(`write-${rand()}`);
      if (row.claimsBaseFirst === true) await plugin.post(base, SENDER, 'claimed');
      const topic = row.topic?.(base) ?? base;

      if (row.refuses !== undefined) {
        await expect(plugin.post(topic, SENDER, row.content)).rejects.toThrow(row.refuses);
        return;
      }
      await plugin.post(topic, SENDER, row.content);
      const { messages } = await plugin.fetchRecent({ topic });
      expect(messages.map((m) => m.content)).toEqual([row.content]);
    });
  }

  it('every modelled server constraint is claimed by a write row or declared a read constraint', () => {
    const claimed = new Set<string>([
      ...WRITE_REWRITES.flatMap((r) => r.constraints),
      ...STREAM_INDICATORS.flatMap((r) => r.constraints),
      ...Object.keys(NON_WRITE_CONSTRAINTS),
    ]);
    expect(Object.keys(SERVER_CONSTRAINTS).filter((key) => !claimed.has(key))).toEqual([]);
  });
});

/**
 * The same class as the table above, one dimension wider: a write's wire fields are not only the
 * message's — `backend_config` supplies one too. Zulip's `to` is a stream INDICATOR that is
 * JSON-decoded before it is read as a name, while the read and register narrows send the same string
 * as a name with no decoding, so a stream whose name the decoder reinterprets is a `post` that
 * reports a durable id for a message no `fetchRecent` on that topic can return — the write-only
 * topic `wireTopic` exists to prevent, arriving through the config instead of through the topic.
 */
const STREAM_INDICATORS: Array<{
  constraints: Array<keyof typeof SERVER_CONSTRAINTS>;
  name: string;
  stream: string;
  /** Absent = a name the decoder leaves alone, which must round-trip through the seam. */
  refuses?: RegExp;
}> = [
  {
    constraints: ['parsesStreamIndicator'],
    name: 'a digits-only name, which the decoder reads as a stream ID',
    stream: '2024',
    refuses: /stream ID/,
  },
  {
    constraints: ['parsesStreamIndicator'],
    name: 'a JSON-quoted name',
    stream: '"parley"',
    refuses: /quoted/,
  },
  {
    constraints: ['parsesStreamIndicator'],
    name: 'a name wrapped in a JSON list',
    stream: '["parley"]',
    refuses: /JSON list/,
  },
  {
    constraints: ['parsesStreamIndicator'],
    name: 'a JSON boolean',
    stream: 'true',
    refuses: /JSON literal/,
  },
  {
    constraints: ['parsesStreamIndicator'],
    name: 'a JSON null',
    stream: 'null',
    refuses: /JSON literal/,
  },
  {
    constraints: ['parsesStreamIndicator'],
    name: 'a name with digits in it that is not valid JSON',
    stream: 'parley-2024',
  },
  {
    constraints: ['parsesStreamIndicator'],
    name: 'a plain name',
    stream: 'parley',
  },
];

describe('zulip refuses a stream name the server would read as something other than that name', () => {
  for (const row of STREAM_INDICATORS) {
    const verdict = row.refuses === undefined ? 'round-trips a post' : 'is refused by connect()';
    it(`${row.name} ${verdict}`, async () => {
      const { fake } = await boot();
      const plugin = new ZulipPlugin();
      const connecting = plugin.connect({ site_url: fake.url, stream: row.stream });
      if (row.refuses !== undefined) {
        await expect(connecting).rejects.toThrow(row.refuses);
        await expect(plugin.connect({ site_url: fake.url, stream: row.stream })).rejects.toThrow(
          'backend_config.stream',
        );
        return;
      }
      await connecting;
      try {
        const topic = asTopic(`ind-${rand()}`);
        await plugin.post(topic, SENDER, 'x');
        const { messages } = await plugin.fetchRecent({ topic });
        expect(messages.map((m) => m.content)).toEqual(['x']);
      } finally {
        await plugin.disconnect();
      }
    });
  }

  /**
   * The plugin now refuses every name the decoder reinterprets, which puts the fake's model out of
   * reach of any call the plugin can make — so, exactly as with the body rewrites above, the model is
   * graded on the wire. Without this the fake could go back to storing `to` verbatim and the rows
   * above would be grading a constraint nothing enforces.
   */
  const DECODED: Array<{ name: string; to: string; narrow: string; status: number; reads: number }> = [
    { name: 'a bare name is the stream named by it', to: 'plain', narrow: 'plain', status: 200, reads: 1 },
    { name: 'digits address a stream ID, not the stream named by those digits', to: '2024', narrow: '2024', status: 200, reads: 0 },
    { name: 'a JSON-quoted name is the name inside the quotes', to: '"plain"', narrow: '"plain"', status: 200, reads: 0 },
    { name: 'a one-element list is the name inside the list', to: '["plain"]', narrow: '["plain"]', status: 200, reads: 0 },
    { name: 'a JSON literal is refused outright', to: 'true', narrow: 'true', status: 400, reads: 0 },
  ];

  for (const row of DECODED) {
    it(`the fake decodes \`to\` as Zulip does: ${row.name}`, async () => {
      const { fake } = await boot();
      const topic = `ind-${rand()}`;
      expect((await rawSend(fake, { to: row.to, topic })).status).toBe(row.status);
      expect(await rawReadCount(fake, { stream: row.narrow, topic })).toBe(row.reads);
    });
  }
});

/**
 * The plugin refuses every body the server would rewrite, which puts the fake's own model out of
 * reach of any call the plugin can make — so the model is graded on the wire instead. Without this,
 * the fake could quietly go back to echoing the payload and every content clause the shared
 * conformance suite grades against this backend would be graded against an echo.
 */
describe('the fake rewrites a body exactly as Zulip documents', () => {
  const STORED: Array<{ name: string; sent: string; stored: string }> = [
    { name: 'strips trailing whitespace', sent: 'hand-off \t\n ', stored: 'hand-off' },
    { name: 'strips leading newlines', sent: '\n\nhand-off', stored: 'hand-off' },
    { name: 'keeps leading spaces', sent: '  hand-off', stored: '  hand-off' },
    {
      name: 'truncates a body past the cap, marker included',
      sent: 'x'.repeat(MAX_BODY + 5000),
      stored:
        'x'.repeat(MAX_BODY - [...SERVER_CONSTRAINTS.bodyTruncationSuffix].length) +
        SERVER_CONSTRAINTS.bodyTruncationSuffix,
    },
  ];

  for (const row of STORED) {
    it(row.name, async () => {
      const { plugin, fake } = await boot();
      const topic = `fake-${rand()}`;
      expect((await rawSend(fake, { topic, content: row.sent })).status).toBe(200);
      const { messages } = await plugin.fetchRecent({ topic: asTopic(topic) });
      expect(messages.map((m) => m.content)).toEqual([row.stored]);
    });
  }

  const REFUSED = [
    { name: 'an empty body', sent: '' },
    { name: 'a whitespace-only body', sent: '   ' },
    { name: 'a body carrying a NUL', sent: 'hand\u0000off' },
  ];

  for (const row of REFUSED) {
    it(`refuses ${row.name}`, async () => {
      const { plugin, fake } = await boot();
      const topic = `fake-${rand()}`;
      expect((await rawSend(fake, { topic, content: row.sent })).status).toBe(400);
      expect((await plugin.fetchRecent({ topic: asTopic(topic) })).messages).toEqual([]);
    });
  }
});

/**
 * CLASS: the BODY strip is graded over the WHOLE whitespace code space, on both sides of the seam at
 * once — the padding table the topic half already had, which the body half never did. The two server
 * strips are DIFFERENT sets (this one is Python `str.rstrip()`, the topic's is pydantic-core's Rust
 * `trim()`) and neither is JavaScript's `\s`, so a body guard written with the wrong one both accepts
 * payloads the server silently rewrites and refuses ones it stores verbatim. Every row grades the
 * plugin's verdict AND, on the wire where the plugin's refusal can no longer reach, what the fake
 * actually stored — so the plugin and the model are each held to the enumerated server set instead
 * of to each other.
 */
describe('zulip post never lets the server rewrite a body, over the whole code space', () => {
  for (const pad of CANDIDATE_PADDINGS) {
    for (const placement of PLACEMENTS) {
      const content = placement.pad(pad, 'hand-off');
      const stored = normalizeBody(content);
      const verdict =
        typeof stored !== 'string'
          ? 'is refused as empty, and the server refuses it too'
          : stored === content
            ? 'round-trips exactly, through the plugin and on the wire'
            : 'is refused, and the server would have stored it rewritten';

      it(`a body ${placement.name} ${padName(pad)} ${verdict}`, async () => {
        const { plugin, fake } = await boot();
        const topic = `body-${rand()}`;

        if (typeof stored !== 'string') {
          await expect(plugin.post(asTopic(topic), SENDER, content)).rejects.toThrow(/empty/i);
          expect((await rawSend(fake, { topic, content })).status).toBe(400);
          return;
        }
        if (stored === content) {
          await plugin.post(asTopic(topic), SENDER, content);
          const { messages } = await plugin.fetchRecent({ topic: asTopic(topic) });
          expect(messages.map((m) => m.content)).toEqual([content]);
          return;
        }
        await expect(plugin.post(asTopic(topic), SENDER, content)).rejects.toThrow(
          /rewrites a message body/,
        );
        expect((await rawSend(fake, { topic, content })).status).toBe(200);
        const { messages } = await plugin.fetchRecent({ topic: asTopic(topic) });
        expect(messages.map((m) => m.content)).toEqual([stored]);
      });
    }
  }
});

/**
 * The topic half of the same wire grading. The plugin refuses every padded name, so only a raw send
 * can still reach the strip — and the strip is what makes the plugin's refusal necessary, so a fake
 * that stopped modelling it would turn the whole padding table above into a test of nothing.
 */
describe('the fake rewrites a topic exactly as Zulip documents', () => {
  const SUBJECTS: Array<{ name: string; pad: string; stored: boolean }> = TOPIC_PADDINGS.map(
    (row) => ({ name: row.name, pad: row.pad, stored: !row.stripped }),
  );

  for (const row of SUBJECTS) {
    const verdict = row.stored ? 'keeps' : 'strips';
    it(`${verdict} ${row.name} on both edges of a subject`, async () => {
      const { fake } = await boot();
      const bare = `fake-topic-${rand()}`;
      const padded = `${row.pad}${bare}${row.pad}`;
      expect((await rawSend(fake, { topic: padded })).status).toBe(200);

      expect(await rawReadCount(fake, { topic: bare })).toBe(row.stored ? 0 : 1);
      expect(await rawReadCount(fake, { topic: padded })).toBe(row.stored ? 1 : 0);
    });
  }

  it('strips before it truncates, so a name only its padding overruns is stored whole', async () => {
    const { fake } = await boot();
    const atTheCap = `x${rand()}`.padEnd(SERVER_CONSTRAINTS.maxTopicNameLength, 'y');
    expect((await rawSend(fake, { topic: ` ${atTheCap} ` })).status).toBe(200);
    expect(await rawReadCount(fake, { topic: atTheCap })).toBe(1);
  });
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
  // `full_name` is set by the account carrying it, so these two are what a member can do to another
  // participant's handle: 50 claims a handle that is nobody's account, 51 shadows a real email.
  { user_id: 50, email: 'mallory@example.com', full_name: 'ctx-payments' },
  { user_id: 51, email: 'shadow@example.com', full_name: 'pat@example.com' },
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

/**
 * CLASS: what an identity lookup does with a SELF-SETTABLE field is pinned by a case that can fail,
 * including the outcome the prose is uncomfortable about. `resolveIdentity`'s uniqueness test
 * defends against ties and nothing more, so a lone member who puts another participant's handle in
 * their display name is an unambiguous match and answers for it — which is exactly what its JSDoc
 * now says, and what these rows hold it to. Change one without the other and this fails.
 */
const DISPLAY_NAME_CLAIMS: Array<{ name: string; handle: string; expected: string }> = [
  {
    name: 'an email beats a display name that shadows it — the email branch is consulted first',
    handle: 'pat@example.com',
    expected: '11',
  },
  {
    name: 'two members sharing a display name is a tie, so it degrades to the string convention',
    handle: 'Pat Sharp',
    expected: 'Pat Sharp',
  },
  {
    name: 'a lone display name claiming a handle nobody owns as an email DOES answer for it',
    handle: 'ctx-payments',
    expected: '50',
  },
];

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

  for (const row of DISPLAY_NAME_CLAIMS) {
    it(row.name, async () => {
      const { plugin } = await boot({ members: DIRECTORY });
      expect(await plugin.resolveIdentity(asHandle(row.handle))).toEqual({
        handle: row.handle,
        backendRef: row.expected,
      });
    });
  }
});
