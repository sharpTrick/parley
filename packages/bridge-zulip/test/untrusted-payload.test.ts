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
import { type ZulipMessage, zulipToMessage } from '../src/wire.js';
import { SERVER_CONSTRAINTS } from './fake-zulip.js';
import { HAZARD_FIELDS as FIELDS, HAZARDS, rand, SENDER, sleep, useZulip } from './harness.js';

const boot = useZulip();

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
   * Every `id` shape the plugin cannot NAME, derived by asking the parser rather than by listing —
   * a shape added to {@link HAZARDS}, or a guard widened in `zulipToMessage`, changes this corpus
   * the day it lands instead of the day someone remembers a row. The old hand-list admitted only
   * the two order-preserving numeric shapes, which is precisely why no row could ever sit at a page
   * EDGE: the shapes that put one there were the ones it excluded.
   */
  const UNNAMEABLE_IDS = HAZARDS.filter(
    (h) => zulipToMessage(asTopic('probe'), { id: h.value } as ZulipMessage) === undefined,
  );

  /** Usable history the unnameable record is buried in; index 0 is the OLDEST. */
  const BURIED = ['g0', 'g1', 'g2', 'g3'];

  /**
   * Where the unnameable record sits. A backwards read pages from the newest, so the record that
   * decides whether the walk can continue is the OLDEST one in the page — cross the position with
   * the caller's `limit` and some row always puts an unnameable record exactly there.
   */
  const POSITIONS = [
    { name: 'first', at: 0 },
    { name: 'interior', at: 2 },
    { name: 'last', at: BURIED.length },
  ];

  for (const position of POSITIONS) {
    // Includes BURIED.length - 1, the only limit that puts an unnameable record on the OLDEST end
    // of the page a backwards read takes — the position from which the next anchor is chosen, and
    // the one every other limit in this table walks straight past.
    for (const limit of [1, 2, BURIED.length - 1, BURIED.length]) {
      it(`limit ${limit} reads the whole window past a ${position.name} unnameable record`, async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { plugin, fake } = await boot();
        const expected = BURIED.slice(-limit);
        for (const shape of UNNAMEABLE_IDS) {
          const where = `${shape.name} at ${position.name}`;
          const topic = asTopic(`unnameable-${rand()}`);
          for (const [i, content] of BURIED.entries()) {
            if (i === position.at) fake.injectRaw({ topic, fields: { id: shape.value } });
            await plugin.post(topic, SENDER, content);
          }
          if (position.at === BURIED.length) {
            fake.injectRaw({ topic, fields: { id: shape.value } });
          }

          const { messages, nextCursor } = await plugin.fetchRecent({ topic, limit });
          expect(messages.map((m) => m.content), where).toEqual(expected);
          expect(Number(nextCursor), where).toBeGreaterThan(0);
          expect((await plugin.fetchRecent({ topic, since: nextCursor })).messages, where).toEqual(
            [],
          );
        }
      }, 60_000);
    }
  }

  /**
   * A step over a page-edge record is paid for by widening the NEXT page by exactly what that step
   * makes it re-read. Without that the walk comes up one short on every page, and the only other way
   * it can ever see past the record is the fallback that asks for a server-CAP page — turning a
   * `limit`-sized read into a 5000-record one against a live server. Graded by running the read and
   * taking the page sizes off the wire, because a walk that is merely correct cannot be told from
   * one that is correct and ruinous.
   */
  it('pays for a step over a page-edge record with a page the size of the step', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { plugin, fake } = await boot();
    const topic = asTopic(`economy-${rand()}`);
    const limit = BURIED.length - 1;
    for (const content of BURIED.slice(0, BURIED.length - limit + 1)) {
      await plugin.post(topic, SENDER, content);
    }
    fake.injectRaw({ topic, fields: { id: 'nope' } });
    for (const content of BURIED.slice(BURIED.length - limit + 1)) {
      await plugin.post(topic, SENDER, content);
    }

    const { messages } = await plugin.fetchRecent({ topic, limit });
    expect(messages.map((m) => m.content)).toEqual(BURIED.slice(-limit));
    const asked = fake.sentParams('GET /api/v1/messages').map((p) => Number(p.num_before));
    expect(Math.max(...asked)).toBeLessThan(SERVER_CONSTRAINTS.maxMessagesPerFetch);
  });

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
