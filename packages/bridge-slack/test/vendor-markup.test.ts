/**
 * CLASS: no inbound-derived string may reach a vendor's markup parser unescaped, and no vendor
 * escaping may reach agent context undecoded. The two halves are one contract — break either and a
 * round trip stops being the identity.
 *
 * (1) AMPLIFICATION. `content` is untrusted: it can be an inbound Matrix/Discord message or a
 *     prompt-injected agent turn. Slack parses `text` as its own markup, so relaying `<!channel>`
 *     verbatim is not a rendering wart — it is a real notification to every member of the channel,
 *     and `<@U0BOSS>` is a real mention of that person. Slack's own rule is that the SENDER escapes
 *     `&`, `<` and `>`. The rows below assert the BYTES the fake received, not just the read-back, so
 *     a plugin that neutralized markup only on the way back in would still fail.
 *
 * (2) FIDELITY. Slack returns `text` with those same three entities escaped — including for text a
 *     human typed into the client — so passing it through hands the agent `a &lt; b` and makes every
 *     read-then-repost hop compound (`&amp;lt;`). Encode and decode are therefore graded as a PAIR:
 *     one round trip must be the identity, and a second must not drift.
 *
 * The next transport with its own markup (Zulip mention syntax, Matrix HTML) inherits the row shape.
 */
import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { escapeSlackText, unescapeSlackText } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';
import { withSlack } from './harness.js';

/**
 * Vendor control markup, and the plain characters that build it. `amplifies` names the rows that
 * would become a live workspace event rather than text — those are the security rows; the rest are
 * fidelity rows. Every row is asserted the same way, so the distinction cannot rot into two suites.
 */
const PAYLOADS: Array<{ name: string; content: string; amplifies: boolean }> = [
  { name: 'a channel broadcast', content: '<!channel> ship it', amplifies: true },
  { name: 'a here broadcast', content: '<!here> standup now', amplifies: true },
  { name: 'an everyone broadcast', content: '<!everyone> all hands', amplifies: true },
  { name: 'a usergroup broadcast', content: 'ping <!subteam^S0OPS|@ops>', amplifies: true },
  { name: 'a bare user mention', content: '<@U0BOSS> approved this', amplifies: true },
  { name: 'a labelled user mention', content: 'cc <@U0BOSS|boss> fyi', amplifies: true },
  { name: 'a masked link', content: 'see <https://evil.example|the docs>', amplifies: true },
  { name: 'a channel link', content: 'discussed in <#C0SECRET|general>', amplifies: true },
  { name: 'a bare ampersand', content: 'this & that', amplifies: false },
  { name: 'a bare less-than', content: 'if a < b then', amplifies: false },
  { name: 'a bare greater-than', content: 'if b > a then', amplifies: false },
  { name: 'all three at once', content: 'if a < b && c > d', amplifies: false },
  { name: 'an entity the author typed literally', content: 'write &amp; for &', amplifies: false },
  { name: 'markup the author typed literally', content: 'the &lt;!channel&gt; syntax', amplifies: false },
  { name: 'plain text with no markup at all', content: 'nothing to escape here', amplifies: false },
];

/** The one axis this file varies: the mention map its payloads name. */
const withPlugin = withSlack.bind(null, { mentionMap: { U0BOSS: 'the-boss', S0OPS: 'ops-crew' } });

describe('slack post: relayed content never reaches Slack as control markup', () => {
  for (const payload of PAYLOADS) {
    it(`escapes ${payload.name} on the wire`, async () => {
      await withPlugin(async (fake, plugin) => {
        const topic = asTopic('C0ESCAPE');
        fake.createChannel(topic);
        await plugin.post(topic, asHandle('writer'), payload.content);

        // What Slack's parser would actually see. Neither character may survive un-entitied — this is
        // the assertion a read-side-only neutralization cannot pass.
        const [wire] = fake.rawTexts(topic);
        expect(wire, 'text on the wire').toBe(escapeSlackText(payload.content));
        expect(wire?.replace(/&(amp|lt|gt);/g, ''), 'un-escaped markup bytes').not.toMatch(/[&<>]/);
        if (payload.amplifies) {
          expect(wire, 'markup must not survive').not.toContain('<');
          expect(wire, 'markup must not survive').not.toContain('>');
        }
      });
    });
  }

  // The class the amplification rows exist for, stated on the READ side too: markup Parley posted is
  // literal text coming back, and specifically NOT a mention of the mapped user it names.
  it('a mention the bridge posts reads back as literal text, not as a mention', async () => {
    await withPlugin(async (fake, plugin) => {
      const topic = asTopic('C0NOAMP');
      fake.createChannel(topic);
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));
      await plugin.post(topic, asHandle('writer'), 'over to you <@U0BOSS> and <!channel>');

      await vi.waitFor(() => expect(live).toHaveLength(1), { timeout: 3000, interval: 10 });
      const { messages } = await plugin.fetchRecent({ topic, limit: 10 });
      for (const [where, m] of [
        ['live', live[0]!],
        ['history', messages.at(-1)!],
      ] as const) {
        expect(m.content, where).toBe('over to you <@U0BOSS> and <!channel>');
        expect(m.mentions.map(String), where).not.toContain('the-boss');
        expect(m.mentions.map(String), where).not.toContain('channel');
      }
    });
  });
});

describe('slack content fidelity: encode and decode are one pair', () => {
  for (const payload of PAYLOADS) {
    it(`post → fetchRecent round-trips ${payload.name} exactly, and a re-post does not compound`, async () => {
      await withPlugin(async (fake, plugin) => {
        const topic = asTopic('C0TRIP');
        fake.createChannel(topic);
        await plugin.post(topic, asHandle('writer'), payload.content);
        const first = await plugin.fetchRecent({ topic, limit: 10 });
        expect(first.messages.map((m) => m.content)).toEqual([payload.content]);

        // Handing a message on is the everyday Parley hop, and it is where a one-sided escape shows
        // up as `&amp;lt;`: re-posting what we read must land the same bytes on the wire again.
        await plugin.post(topic, asHandle('relay'), first.messages[0]!.content);
        const second = await plugin.fetchRecent({ topic, limit: 10 });
        expect(second.messages.map((m) => m.content)).toEqual([payload.content, payload.content]);
        expect(new Set(fake.rawTexts(topic)).size, 'wire bytes drifted across the hop').toBe(1);
      });
    });
  }

  // The vendor-side half of the pair: text a HUMAN typed in Slack arrives already escaped, and
  // reaches the plugin only through history/push — never through `post` — so no round-trip row can
  // reach it. Anything Slack escapes must be decoded before it becomes agent context.
  for (const [name, stored, expected] of [
    ['a less-than a human typed', 'if a &lt; b', 'if a < b'],
    ['a greater-than a human typed', 'if b &gt; a', 'if b > a'],
    ['an ampersand a human typed', 'this &amp; that', 'this & that'],
    ['all three at once', 'if a &lt; b &amp;&amp; c &gt; d', 'if a < b && c > d'],
    ['a doubly-escaped entity', 'write &amp;lt; for a tag', 'write &lt; for a tag'],
    ['markup typed as literal text', 'the &lt;!channel&gt; syntax', 'the <!channel> syntax'],
    ['a real mention beside an entity', 'a &lt; b <@U0BOSS>', 'a < b @the-boss'],
  ] as const) {
    it(`history and push both decode ${name}`, async () => {
      await withPlugin(async (fake, plugin) => {
        const topic = asTopic('C0DECODE');
        fake.createChannel(topic);
        const live: Message[] = [];
        await plugin.subscribe(topic, (m) => live.push(m));

        fake.seed(topic, [{ text: stored }]);
        fake.pushEvent(topic, { ts: fake.mintTs(), text: stored, user: 'U0HUMAN' });
        await vi.waitFor(() => expect(live).toHaveLength(1), { timeout: 3000, interval: 10 });

        const { messages } = await plugin.fetchRecent({ topic, limit: 10 });
        expect(messages.map((m) => m.content), 'history').toEqual([expected]);
        expect(live.map((m) => m.content), 'live push').toEqual([expected]);
      });
    });
  }

  // Literal markup a human typed must NOT be decoded back into markup and then rewritten as a
  // mention: that would let anyone in the channel forge a mention of a mapped handle by typing it.
  it('decoding never resurrects markup for the mention rewrite to find', async () => {
    await withPlugin(async (fake, plugin) => {
      const topic = asTopic('C0FORGE');
      fake.seed(topic, [{ text: 'try typing &lt;@U0BOSS&gt; yourself' }]);
      const { messages } = await plugin.fetchRecent({ topic, limit: 10 });
      expect(messages[0]!.content).toBe('try typing <@U0BOSS> yourself');
      expect(messages[0]!.mentions.map(String)).not.toContain('the-boss');
    });
  });
});

/**
 * The two helpers, graded directly rather than only through the wire. The ORDER of the three
 * replacements is the whole correctness argument (`&` first on encode, last on decode), and a wire
 * assertion cannot distinguish a wrong order from a right one on a payload with no `&`.
 */
describe('slack escaping helpers', () => {
  it.each(
    PAYLOADS.map((p) => p.content).concat([
      '&',
      '&amp;',
      '&amp;amp;',
      '&lt;',
      '&amp;lt;',
      '<>&',
      '',
    ]),
  )('decode(encode(%j)) is the identity', (content) => {
    expect(unescapeSlackText(escapeSlackText(content))).toBe(content);
  });

  it('encodes ampersand first, so no escape is silently unescaped', () => {
    expect(escapeSlackText('&lt;')).toBe('&amp;lt;');
    expect(escapeSlackText('<')).toBe('&lt;');
  });

  it('decodes ampersand last, so a doubly-escaped entity decodes only one level', () => {
    expect(unescapeSlackText('&amp;lt;')).toBe('&lt;');
    expect(unescapeSlackText('&lt;')).toBe('<');
  });
});

/**
 * CLASS: a vendor-markup rewrite applied to UNBOUNDED untrusted text. Slack's own `text` limit is
 * 40 000 characters, so every string below is a message anyone who can post in a mapped channel may
 * legally send — and the rewrite runs on it inside `ws.on('message')` as well as on the history
 * walk, i.e. on the single thread that also owes Slack an ack for every envelope. A pattern whose
 * scan from one `<` can run past the next one costs O(n²) on exactly these shapes: 40 000
 * characters of `<@` measured 1.5 s of fully blocked event loop, and one page of them over a minute.
 *
 * The rows are the START SHAPES a mention pattern can anchor on, crossed with length, because what
 * makes the cost quadratic is the number of overlapping start positions rather than any one match.
 * Time is the only observable — every row returns its text either way — so each asserts a per-
 * message wall-clock budget on BOTH delivery paths, and that the socket is still serving afterwards.
 * The next transport with its own markup inherits the table with its own units.
 */
const FLOOD_UNITS: Array<{ name: string; unit: string }> = [
  { name: 'unterminated user mentions', unit: '<@' },
  { name: 'unterminated broadcasts', unit: '<!' },
  { name: 'unterminated labelled mentions', unit: '<@x|' },
  { name: 'unterminated mentions with an empty body', unit: '<@|' },
  { name: 'unterminated usergroups', unit: '<!subteam^' },
  { name: 'unterminated channel links', unit: '<#' },
  { name: 'bare less-thans', unit: '<' },
  { name: 'bare ampersands', unit: '&' },
  { name: 'complete mentions', unit: '<@U0BOSS>' },
  { name: 'complete broadcasts', unit: '<!here>' },
];

/** Slack's own `text` ceiling is the largest a real workspace can hand us. */
const FLOOD_LENGTHS = [10_000, 40_000];

/** Wall clock one message of vendor markup may cost. Linear rewriting spends under 1 ms at 40 000. */
const FLOOD_BUDGET_MS = 20;

const floodTexts = (length: number): string[] =>
  FLOOD_UNITS.map(({ unit }) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length));

describe('slack mention rewrite stays linear in the length of untrusted text', () => {
  for (const length of FLOOD_LENGTHS) {
    const budget = FLOOD_UNITS.length * FLOOD_BUDGET_MS;

    it(`history: a page of ${length}-character floods costs under ${budget} ms`, async () => {
      await withPlugin(async (fake, plugin) => {
        const topic = asTopic('C0FLOODHIST');
        const texts = floodTexts(length);
        fake.seed(
          topic,
          texts.map((text) => ({ text })),
        );

        const t0 = Date.now();
        const { messages } = await plugin.fetchRecent({ topic, limit: 100 });
        const elapsed = Date.now() - t0;

        expect(messages).toHaveLength(texts.length);
        expect(elapsed, `${texts.length} messages of ${length} chars`).toBeLessThan(budget);
      });
    });

    it(`live push: the same floods are delivered under ${budget} ms and the socket keeps serving`, async () => {
      await withPlugin(async (fake, plugin) => {
        const topic = asTopic('C0FLOODLIVE');
        fake.createChannel(topic);
        const live: Message[] = [];
        await plugin.subscribe(topic, (m) => live.push(m));

        const texts = floodTexts(length);
        const t0 = Date.now();
        const pushed = texts.map((text) => fake.pushEvent(topic, { ts: fake.mintTs(), text }));
        await vi.waitFor(() => expect(live).toHaveLength(texts.length), {
          timeout: 8000,
          interval: 5,
        });
        expect(Date.now() - t0, `${texts.length} envelopes of ${length} chars`).toBeLessThan(budget);

        // A blocked event loop starves the ack, which is what makes Slack redeliver and then drop
        // the connection — so the ack is graded, not just the delivery.
        await vi.waitFor(
          () => {
            for (const id of pushed) expect(fake.acked.has(id), `ack for ${id}`).toBe(true);
          },
          { timeout: 4000, interval: 5 },
        );
        await plugin.post(topic, asHandle('writer'), 'still alive');
        await vi.waitFor(() => expect(live.at(-1)?.content).toBe('still alive'), {
          timeout: 4000,
          interval: 5,
        });
      });
    });
  }
});

/**
 * The fake refuses un-escaped markup, and that refusal is itself a guard that can rot. Drive it
 * directly, so a fake that silently stopped grading fails HERE instead of greening every row above.
 */
describe('the fake grades the sender-side escaping obligation', () => {
  it.each([
    ['a raw broadcast', '<!channel> ship it', true],
    ['a raw mention', '<@U0BOSS>', true],
    ['a raw ampersand', 'a & b', true],
    ['a raw greater-than', 'a > b', true],
    ['properly escaped markup', '&lt;!channel&gt; ship it', false],
    ['a properly escaped ampersand', 'a &amp; b', false],
    ['text needing no escaping', 'plain words', false],
  ])('refuses %s: %s', async (_label, wireText, refused) => {
    const fake = await FakeSlack.start();
    try {
      fake.createChannel('C0FAKEGRADE');
      const res = await fetch(`${fake.apiUrl}/chat.postMessage`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer xoxb-test',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ channel: 'C0FAKEGRADE', text: wireText }).toString(),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      expect(json.ok, wireText).toBe(!refused);
      if (refused) expect(json.error).toBe('unescaped_markup');
    } finally {
      await fake.close();
    }
  });
});
