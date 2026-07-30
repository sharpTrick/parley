/**
 * CLASS: no shape a server-controlled field can arrive in may throw out of the seam. The plugin
 * declares wire types for a Zulip message record, but nothing on the wire is obliged to honour them
 * — a `timestamp` outside `Date`'s range reaches `toISOString`, a non-string `content` reaches core's
 * mention parser, and either throw escapes `fetchRecent`, which means catch-up fails identically on
 * every subsequent start rather than once. An `id` is the one field that cannot be coerced (it is
 * BOTH the dedup key and the cursor), so an unusable one drops the record instead of minting a
 * `'NaN'` cursor the next `anchor` cannot use.
 *
 * The table is the cross product of every field a server controls and every shape the declaration
 * says it cannot hold, so a field added to the wire type meets the whole hazard list by adding one
 * name; the push case then drives the same gauntlet through a LIVE event queue, because the read
 * path and the loop normalize the record at two different call sites.
 *
 * Dropping a record must also never truncate the read: the second table crosses the unusable-`id`
 * shapes with the caller's `limit`, because a page is only full — and the pagination anchor only
 * load-bearing — when the records dropped fill the page the caller asked for.
 */
import { asCursor, asTopic, type Cursor, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { SERVER_CONSTRAINTS } from './fake-zulip.js';
import { rand, SENDER, sleep, useZulip } from './harness.js';

const boot = useZulip();

/** Every server-controlled field of a Zulip message record the plugin reads. */
const FIELDS = ['id', 'content', 'sender_email', 'timestamp'] as const;

/** Shapes the declared wire types say cannot arrive. Names double as the test titles. */
const HAZARDS: Array<{ name: string; value: unknown }> = [
  { name: 'missing', value: undefined },
  { name: 'null', value: null },
  { name: 'zero', value: 0 },
  { name: 'negative', value: -1 },
  { name: 'fractional', value: 1.5 },
  { name: 'past the Date range', value: 1e18 },
  { name: 'before the Date range', value: -1e18 },
  { name: 'NaN', value: Number.NaN },
  { name: 'Infinity', value: Number.POSITIVE_INFINITY },
  { name: 'a string', value: 'nope' },
  { name: 'an empty string', value: '' },
  { name: 'an object', value: { nested: true } },
  { name: 'an array', value: [1, 2] },
  { name: 'a boolean', value: true },
  { name: 'a huge string', value: 'x'.repeat(70_000) },
  { name: 'non-ASCII around a control character', value: '\u{1F600}\u0000caf\u00e9' },
];

/** Everything above the seam relies on; a Message that fails any of these is not usable. */
function expectWellFormed(m: Message): void {
  expect(typeof m.content).toBe('string');
  expect(typeof m.senderHandle).toBe('string');
  expect(Number.isNaN(Date.parse(m.timestamp))).toBe(false);
  expect(m.backendMsgId.length).toBeGreaterThan(0);
  expect(m.cursor).toBe(String(Number(m.cursor)));
  expect(Number(m.cursor)).toBeGreaterThan(0);
  expect(Array.isArray(m.mentions)).toBe(true);
}

describe('a hostile record shape never throws out of fetchRecent', () => {
  for (const field of FIELDS) {
    // Only `id` decides whether the record is usable at all; every other field is coerced.
    const dropped = field === 'id';
    it(`every hazard shape of \`${field}\` is ${dropped ? 'dropped' : 'normalized'}`, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { plugin, fake } = await boot();
      for (const hazard of HAZARDS) {
        const where = `${field} = ${hazard.name}`;
        const topic = asTopic(`hostile-${rand()}`);
        fake.injectRaw({ topic, fields: { [field]: hazard.value } });

        const { messages, nextCursor } = await plugin.fetchRecent({ topic });
        expect(messages, where).toHaveLength(dropped ? 0 : 1);
        for (const m of messages) expectWellFormed(m);
        expect(typeof nextCursor, where).toBe('string');

        // …and the same record read a second time, exclusively, cannot resurrect or duplicate it.
        const after = await plugin.fetchRecent({ topic, since: nextCursor });
        expect(after.messages, where).toEqual([]);
      }
    }, 20_000);
  }

  /**
   * `id` shapes the plugin cannot use as a cursor that still ORDER after the history behind them, so
   * a whole page can consist of them. A shape that mangles the record's order too (a negative or
   * non-numeric id) cannot model a page — Zulip ids are monotonic — so those stay in the sweep above.
   */
  const UNUSABLE_IDS = [
    { name: 'fractional', value: 1.5 },
    { name: 'past the safe-integer range', value: 1e18 },
  ];

  /** Small enough to be served whole, and one of them equals the page the caller asked for. */
  const AHEAD = [1, 3];

  for (const shape of UNUSABLE_IDS) {
    for (const ahead of AHEAD) {
      for (const limit of [1, 2, 100]) {
        it(`limit ${limit} reads past ${ahead} record(s) whose \`id\` is ${shape.name}`, async () => {
          vi.spyOn(console, 'warn').mockImplementation(() => undefined);
          const { plugin, fake } = await boot();
          const topic = asTopic(`unusable-${rand()}`);
          await plugin.post(topic, SENDER, 'behind');
          for (let i = 0; i < ahead; i++) {
            fake.injectRaw({ topic, fields: { id: shape.value + i } });
          }

          const { messages, nextCursor } = await plugin.fetchRecent({ topic, limit });
          expect(messages.map((m) => m.content)).toEqual(['behind']);
          expect(Number(nextCursor)).toBeGreaterThan(0);
          expect((await plugin.fetchRecent({ topic, since: nextCursor })).messages).toEqual([]);
        });
      }
    }
  }

  it('a messages response that is not an object with an array under `messages` reads as empty', async () => {
    const { plugin, fake } = await boot();
    const topic = asTopic(`hostile-body-${rand()}`);
    for (const body of [{}, { result: 'success' }, { result: 'success', messages: null }]) {
      fake.failRoute('GET /api/v1/messages', { status: 200, body, times: 1 });
      expect(await plugin.fetchRecent({ topic })).toEqual({ messages: [], nextCursor: '0' });
    }
  });

  it('a post whose response carries no usable id fails loudly instead of minting one', async () => {
    const { plugin, fake } = await boot();
    const topic = asTopic(`hostile-post-${rand()}`);
    for (const body of [{ result: 'success' }, { result: 'success', id: 'seven' }]) {
      fake.failRoute('POST /api/v1/messages', { status: 200, body, times: 1 });
      await expect(plugin.post(topic, SENDER, 'x')).rejects.toThrow('usable message id');
    }
  });

  it('a register whose response carries no usable queue_id fails loudly instead of polling one', async () => {
    const { plugin, fake } = await boot();
    const topic = asTopic(`hostile-reg-${rand()}`);
    fake.failRoute('POST /api/v1/register', {
      status: 200,
      body: { result: 'success', last_event_id: -1 },
      times: 1,
    });
    await expect(plugin.subscribe(topic, () => undefined)).rejects.toThrow('usable queue_id');
  });
});

/**
 * CLASS: a paginating read must TERMINATE whatever the server answers with. The read navigates by
 * the RAW edge record of the page it just took — which is what lets it walk past records it cannot
 * use — so a server answering a full page whose edge carries an id that does not move in the
 * direction of travel walks it onto the same page forever. Every early return in that walk is
 * required to name the answer that makes it fire; a defensive clause no fixture can reach is
 * counted as coverage and grades nothing.
 */
describe('a server whose pages do not advance the anchor cannot spin the read', () => {
  /** Each shape stops the walk via a different clause, so no row stands in for its neighbour. */
  const NON_ADVANCING_EDGES = [
    { name: 'zero', edgeId: 0 },
    { name: 'negative', edgeId: -1 },
    { name: 'fractional', edgeId: 1.5 },
    { name: 'the id it was already asked from', edgeId: 7 },
    { name: 'a string', edgeId: 'nope' },
    { name: 'absent', edgeId: undefined },
  ];
  const DIRECTIONS: Array<{ name: string; since: Cursor | undefined }> = [
    { name: 'the since-less backward walk', since: undefined },
    { name: 'a since-based forward walk', since: asCursor('7') },
  ];
  /** A walk that terminates takes the stalled page and one probe past it; anything more is a spin. */
  const MAX_PAGES = 3;

  for (const edge of NON_ADVANCING_EDGES) {
    for (const direction of DIRECTIONS) {
      for (const limit of [3, SERVER_CONSTRAINTS.maxMessagesPerFetch + 1]) {
        it(`ends ${direction.name} at limit ${limit} when every page edge is ${edge.name}`, async () => {
          vi.spyOn(console, 'warn').mockImplementation(() => undefined);
          const { plugin, fake } = await boot();
          const topic = asTopic(`stall-${rand()}`);
          fake.stallAnchor(edge.edgeId);

          const outcome = await Promise.race([
            plugin
              .fetchRecent({ topic, since: direction.since, limit })
              .then(() => 'returned')
              .catch(() => 'threw'),
            sleep(3000).then(() => 'spun'),
          ]);

          expect(outcome).toBe('returned');
          expect(fake.requestCount('GET /api/v1/messages')).toBeLessThanOrEqual(MAX_PAGES);
        }, 20_000);
      }
    }
  }
});

describe('a live push loop survives the same gauntlet', () => {
  it('every hostile shape in sequence leaves the loop delivering and the process clean', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rejections: unknown[] = [];
    const collect = (err: unknown): void => void rejections.push(err);
    process.on('unhandledRejection', collect);
    try {
      const { plugin, fake } = await boot();
      const topic = asTopic(`hostile-push-${rand()}`);
      const got: Message[] = [];
      await plugin.subscribe(topic, (m) => got.push(m));

      for (const field of FIELDS) {
        for (const hazard of HAZARDS) {
          fake.injectRaw({ topic, fields: { [field]: hazard.value } });
          await sleep(2);
        }
      }
      await sleep(400);
      await plugin.post(topic, SENDER, 'still alive');
      await sleep(600);

      for (const m of got) expectWellFormed(m);
      expect(got.at(-1)?.content).toBe('still alive');
      // One delivery per hazard for every coercible field, none for the unusable ids, plus the probe.
      expect(got).toHaveLength((FIELDS.length - 1) * HAZARDS.length + 1);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', collect);
    }
  }, 30_000);
});
