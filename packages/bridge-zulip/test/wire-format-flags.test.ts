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

/**
 * One request SHAPE and the value the flag must carry on it. A flag's correct value can depend on
 * which call issued the request — `include_anchor` must be `false` on every read anchored at a real
 * message id, because including the anchor re-delivers a record the previous page already returned,
 * while on `anchor=newest` the server resolves a sentinel no row can carry
 * ({@link SERVER_CONSTRAINTS.newestAnchor}) and the flag decides nothing at all. A `some(...)`
 * assertion cannot pin that: one request of the right shape satisfies it for every other shape,
 * so the direction where the flag IS load-bearing can be broken with the table still green.
 */
interface WireRule {
  /** Names the shape; also the label a violation is reported under. */
  shape: string;
  applies: (params: Record<string, string>) => boolean;
  value: string;
}

interface FlagRow {
  flag: keyof typeof SERVER_CONSTRAINTS.requestFlagDefaults;
  /** The route the flag must appear on. */
  route: string;
  /** Must MATCH at least one request in the run, and hold on EVERY request it matches. */
  wire: WireRule[];
  /** Fake/plugin settings this row needs on top of the shared fixture's defaults. */
  boot?: { heartbeatMs: number; config: Record<string, unknown> };
  /** What the bridge must observe. Also the run whose emitted requests the wire check reads. */
  pluginGets: (pair: ZulipPair, topic: string) => Promise<void>;
  /** Which rule's shape {@link FlagRow.divergenceShows} exercises, and the value it sends there. */
  divergesOn: { shape: string; value: string };
  /** What the fake does on {@link FlagRow.divergesOn} — proves it can tell the two apart. */
  divergenceShows: (pair: ZulipPair, topic: string) => Promise<void>;
}

/** Requests of a narrowed read, split by what their `anchor` names. */
const ANCHORED_AT_A_MESSAGE_ID = (p: Record<string, string>): boolean =>
  Number.isFinite(Number(p.anchor));
const ANCHORED_AT_NEWEST = (p: Record<string, string>): boolean => p.anchor === 'newest';

const FLAGS: FlagRow[] = [
  {
    flag: 'apply_markdown',
    route: 'GET /api/v1/messages',
    wire: [{ shape: 'any narrowed read', applies: () => true, value: 'false' }],
    divergesOn: { shape: 'any narrowed read', value: 'true' },
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
    route: 'GET /api/v1/messages',
    wire: [
      // The load-bearing direction: the anchor is a record the caller already holds, so including
      // it re-delivers it — as an exclusive `since` that is not exclusive, or as a paginated walk
      // that returns the previous page's edge again.
      { shape: 'anchored at a message id', applies: ANCHORED_AT_A_MESSAGE_ID, value: 'false' },
      // The server resolves `newest` to a sentinel no row carries and takes `anchored_to_right`,
      // which drops the flag from the query outright — so `true` here is the value that stays
      // correct if that ever stops being true, and the only thing that can grade it is the wire.
      { shape: 'anchored at newest', applies: ANCHORED_AT_NEWEST, value: 'true' },
    ],
    divergesOn: { shape: 'anchored at a message id', value: 'true' },
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
    route: 'GET /api/v1/events',
    wire: [{ shape: 'any events poll', applies: () => true, value: 'false' }],
    divergesOn: { shape: 'any events poll', value: 'true' },
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

    it(`${row.flag} is on the wire with the value each request SHAPE needs`, async () => {
      const pair = await open();
      await row.pluginGets(pair, `flag-${rand()}`);
      const sent = pair.fake.sentParams(row.route);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.filter((p) => p[row.flag] === undefined)).toEqual([]);
      // A rule that matched no request grades nothing, so report it beside the violations rather
      // than letting the run pass on the shapes it happened to emit.
      const wrong: string[] = [];
      const ungraded: string[] = [];
      for (const rule of row.wire) {
        const matched = sent.filter((p) => rule.applies(p));
        if (matched.length === 0) ungraded.push(rule.shape);
        for (const p of matched) {
          if (p[row.flag] !== rule.value) {
            wrong.push(`${rule.shape}: ${row.flag}=${String(p[row.flag])}, need ${rule.value}`);
          }
        }
      }
      expect({ wrong, ungraded }).toEqual({ wrong: [], ungraded: [] });
    });

    it(`${row.flag}: the fake behaves differently on ${row.divergesOn.value}`, async () => {
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

  it('never grades a divergence against the value the bridge sends on that same shape', () => {
    const unusable = FLAGS.filter((r) => {
      const rule = r.wire.find((w) => w.shape === r.divergesOn.shape);
      return rule === undefined || rule.value === r.divergesOn.value;
    });
    expect(unusable.map((r) => r.flag)).toEqual([]);
  });

  it('names which server defaults are hostile and which already agree with the bridge', () => {
    const hostile = FLAGS.filter((r) =>
      r.wire.some((w) => SERVER_CONSTRAINTS.requestFlagDefaults[r.flag] !== w.value),
    );
    expect(hostile.map((r) => r.flag)).toEqual(['apply_markdown', 'include_anchor']);
    expect(SERVER_CONSTRAINTS.requestFlagDefaults.dont_block).toBe('false');
  });
});
