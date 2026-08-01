import { asBackendMsgId, asCursor, asHandle, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { RedisPlugin } from '../src/index.js';
import {
  freshTopic as mintTopic,
  isRedisUp,
  REDIS_URL,
  withPlugin,
  withWriter,
  type Writer,
} from './support.js';

const freshTopic = (): Topic => mintTopic('live-stream');

const redisUp = await isRedisUp(REDIS_URL);

// -------------------------------------------------------------------------------------------
// CLASS: a record this plugin did not write still has to normalize into a valid Message. Streams
// are shared across sessions, plugin versions and anyone holding a redis-cli, so `sender`/`ts`
// are not guaranteed to be there — and DESIGN §5 promises an ISO timestamp and a sender either way.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — entries written by a foreign writer', () => {
  // Every row declares the timestamp it must DERIVE, not merely that one parses: an assertion of the
  // form `!Number.isNaN(Date.parse(ts))` is satisfied by any constant, so replacing the derivation
  // with `new Date(0)` would report 1970 for every message and the suite would certify it.
  // `from-id` = the stream id's own millisecond component; `from-ts` = the entry's own `ts`.
  //
  // The `from-ts` rows carry a SPELLING axis, because DESIGN §5 declares a FORMAT and not merely a
  // parseable string: `Date.parse` accepts RFC 2822, `MM/DD/YYYY`, a bare year and a date with no
  // time, and forwarding one verbatim puts it into `Message.timestamp` — where which spellings are
  // accepted is implementation-defined, so the same entry can normalize differently per Node
  // release. For `from-id` one row per unusable spelling would prove nothing: an empty `ts`,
  // `not-a-date` and a bare epoch number all take the same fallback.
  type Derivation = 'from-id' | 'from-ts';
  /** One ISO instant, so the two tables below cannot disagree about what a usable `ts` looks like. */
  const WELL_KNOWN_TS = '2020-05-06T07:08:09.000Z';
  const foreignEntries: Array<[string, Record<string, string>, Derivation]> = [
    ['no recognised field at all', { unrelated: '1' }, 'from-id'],
    ['content only (a human via redis-cli)', { content: 'hi from redis-cli' }, 'from-id'],
    ['sender only', { sender: 'alice' }, 'from-id'],
    ['an empty sender', { sender: '', content: 'anon' }, 'from-id'],
    ['a ts that is not a date', { sender: 'alice', content: 'hi', ts: 'not-a-date' }, 'from-id'],
    ['an ISO ts of its own', { sender: 'a', content: 'hi', ts: WELL_KNOWN_TS }, 'from-ts'],
    ['an ISO ts with an offset', { sender: 'a', content: 'hi', ts: '2020-05-06T07:08:09+02:00' }, 'from-ts'],
    ['an ISO date with no time', { sender: 'a', content: 'hi', ts: '2020-05-06' }, 'from-ts'],
    ['an RFC 2822 ts', { sender: 'a', content: 'hi', ts: 'Tue, 05 Nov 2024 10:00:00 GMT' }, 'from-ts'],
    ["a ts in Date's own toString form", { sender: 'a', content: 'hi', ts: 'Mon Jan 01 2020' }, 'from-ts'],
    ['a MM/DD/YYYY ts', { sender: 'a', content: 'hi', ts: '12/25/2021' }, 'from-ts'],
    ['a bare-year ts', { sender: 'a', content: 'hi', ts: '2020' }, 'from-ts'],
    ['extra unknown fields', { sender: 'alice', content: 'hi', shape: 'm.text', edited: '1' }, 'from-id'],
    ['binary-ish content', { sender: 'alice', content: '\u00ff\u00fe\u0001bin' }, 'from-id'],
  ];

  it.each(foreignEntries)('normalizes an entry with %s', async (_label, fields, derivation) =>
    withPlugin({}, ({ plugin, prefix }) =>
      withWriter(async (writer) => {
        const t = freshTopic();
        const id = await writer.xAdd(`${prefix}${t}`, '*', fields);
        const page = await plugin.fetchRecent({ topic: t, limit: 10 });
        const [m] = page.messages;
        expect(m, 'the foreign entry did not come back at all').toBeDefined();
        expect(m?.topic).toBe(t);
        expect(m?.backendMsgId).toBe(id);
        expect(m?.cursor).toBe(id);
        expect(m?.content).toBe(fields.content ?? '');
        expect(m?.senderHandle, 'an empty handle collides with every other empty handle').not.toBe(
          '',
        );
        const source =
          derivation === 'from-ts' ? Date.parse(fields.ts ?? '') : Number(id.split('-')[0]);
        expect(m?.timestamp, `timestamp is not derived ${derivation}`).toBe(
          new Date(source).toISOString(),
        );
        // Parseability is not the contract: `Date.parse` accepts `12/25/2021` and `2020`, so only
        // re-serializing to the canonical form can say the value IS ISO 8601 (DESIGN §5).
        expect(
          m?.timestamp,
          `timestamp ${JSON.stringify(m?.timestamp)} is not in ISO 8601 form (DESIGN §5)`,
        ).toBe(new Date(m?.timestamp ?? '').toISOString());
      }),
    ),
  );

  // The inverse half: an entry this plugin wrote must report the wall-clock time of the post. Only a
  // bracketed window can say so — every other assertion on Message.timestamp here and in the shared
  // conformance suite tests parseability, which any constant satisfies.
  it('reports the wall-clock time of a post it made itself', async () =>
    withPlugin({}, async ({ plugin }) => {
      const t = freshTopic();
      const before = Date.now();
      await plugin.post(t, asHandle('w'), 'now');
      const after = Date.now();
      const [m] = (await plugin.fetchRecent({ topic: t, limit: 10 })).messages;
      const at = Date.parse(m?.timestamp ?? '');
      expect(
        at,
        `timestamp ${JSON.stringify(m?.timestamp)} is outside the window the post ran in`,
      ).toBeGreaterThanOrEqual(before - 1000);
      expect(at).toBeLessThanOrEqual(after + 1000);
    }));

  // ----------------------------------------------------------------------------------------
  // The axis the field table above holds fixed: every one of its rows writes at `'*'`, so the
  // ENTRY ID — the other value a foreign writer chooses, and the one the timestamp falls back to —
  // is graded by nothing. Both components of a stream id are uint64, which reaches far past the
  // instant `Date` can represent, so an id is arithmetic input from an untrusted writer: a value
  // out of that range throws `RangeError` out of `fetchRecent` (permanently, since the entry is
  // durable) and is swallowed on the `subscribe` path, dropping the entry with no diagnostic.
  //
  // The ids are DERIVED from the uint64 bound and from `Date`'s own range rather than hand-picked,
  // and every row is graded on BOTH paths, so neither half can be fixed while the other still
  // throws.
  // ----------------------------------------------------------------------------------------

  /** The bound each component of a stream entry id is held to. */
  const ID_CEILING = 2n ** 64n - 1n;
  /** The last instant `Date` can represent; `new Date` of one millisecond more is a `RangeError`. */
  const LAST_DATE_MS = 8_640_000_000_000_000n;

  const foreignIds: Array<[string, string]> = [
    ['the first id a stream can hold', '1-0'],
    ['a present-day id', `${Date.now()}-0`],
    ['the last millisecond Date can represent', `${LAST_DATE_MS}-0`],
    ['one millisecond past what Date can represent', `${LAST_DATE_MS + 1n}-0`],
    ['the first millisecond past a safe integer', `${2n ** 53n + 1n}-0`],
    ['the ceiling millisecond at sequence zero', `${ID_CEILING}-0`],
    ['the largest id a stream can ever mint', `${ID_CEILING}-${ID_CEILING}`],
  ];

  /** Whether the entry carries a usable `ts` of its own — which decides where the derivation comes from. */
  const tsRows: Array<[string, Record<string, string>, Derivation]> = [
    ['no usable ts', { sender: 'mallory', content: 'hi' }, 'from-id'],
    ['an ISO ts of its own', { sender: 'mallory', content: 'hi', ts: WELL_KNOWN_TS }, 'from-ts'],
  ];

  const idRows = foreignIds.flatMap(([idLabel, id]) =>
    tsRows.map(
      ([tsLabel, fields, derivation]) =>
        [`${idLabel}, with ${tsLabel}`, id, fields, derivation] as [
          string,
          string,
          Record<string, string>,
          Derivation,
        ],
    ),
  );

  it.each(idRows)('normalizes an entry written at %s', async (_label, id, fields, derivation) =>
    withPlugin({}, ({ plugin, prefix }) =>
      withWriter(async (writer) => {
        const t = freshTopic();
        const live: Array<{ timestamp: string }> = [];
        // Subscribed FIRST, so the same entry is graded on the live path and on catch-up: the live
        // half swallows its own throw, so only an entry that must ARRIVE can see it.
        await plugin.subscribe(t, (m) => live.push(m));
        await writer.xAdd(`${prefix}${t}`, id, fields);

        const page = await plugin.fetchRecent({ topic: t, limit: 10 });
        const [m] = page.messages;
        expect(m, `fetchRecent did not return the entry written at ${id}`).toBeDefined();
        expect(m?.backendMsgId).toBe(id);
        await expect.poll(() => live.length, { timeout: 5000, interval: 50 }).toBe(1);

        const ms = BigInt(id.split('-')[0] ?? '0');
        const derived =
          derivation === 'from-ts'
            ? new Date(Date.parse(fields.ts ?? '')).toISOString()
            : ms <= LAST_DATE_MS
              ? new Date(Number(ms)).toISOString()
              : undefined;
        for (const [path, timestamp] of [
          ['fetchRecent', m?.timestamp],
          ['subscribe', live[0]?.timestamp],
        ] as const) {
          // ISO 8601 (DESIGN §5) whatever the writer chose — the invariant an id out of Date's
          // range breaks by throwing rather than by returning something wrong.
          expect(
            timestamp,
            `${path}: timestamp ${JSON.stringify(timestamp)} is not in ISO 8601 form (DESIGN §5)`,
          ).toBe(new Date(Date.parse(timestamp ?? '')).toISOString());
          // …and where the entry names a representable instant, it is the one reported: without
          // this the whole table is satisfied by reporting 1970 for every message.
          if (derived !== undefined) {
            expect(timestamp, `${path}: timestamp is not derived ${derivation}`).toBe(derived);
          }
        }

        // …and the topic is not wedged: the entry is durable, so a throw here repeats forever.
        const again = await plugin.fetchRecent({ topic: t, limit: 10 });
        expect(again.messages.map((x) => x.backendMsgId)).toEqual([id]);
      }),
    ),
  );

  it('normalizes a foreign entry arriving over the LIVE path too', async () =>
    withPlugin({}, ({ plugin, prefix }) =>
      withWriter(async (writer) => {
        const t = freshTopic();
        const live: Array<{ senderHandle: string; timestamp: string }> = [];
        await plugin.subscribe(t, (m) => live.push(m));
        await writer.xAdd(`${prefix}${t}`, '*', { content: 'from redis-cli', ts: '12/25/2021' });
        await expect.poll(() => live.length, { timeout: 5000, interval: 50 }).toBe(1);
        expect(live[0]?.senderHandle).not.toBe('');
        expect(live[0]?.timestamp, 'the live path forwards a non-ISO ts verbatim').toBe(
          new Date(Date.parse('12/25/2021')).toISOString(),
        );
      }),
    ));
});

// -------------------------------------------------------------------------------------------
// CLASS: a value this plugin writes to the backend that NO seam-level assertion can observe.
// `Message` carries no reply member and `rowToMessage` never reads one, so `in_reply_to` — the
// seam's only threading argument — could be dropped from the XADD with the whole suite green,
// including the conformance clause that posts with `inReplyTo` and reads the reply back. The stream
// outlives this plugin version and is shared with every other session and anyone holding a
// redis-cli, so what is on the wire is a contract even where nothing in this process reads it back.
//
// Read back through an INDEPENDENT client and graded from the entry's own field map, so a field
// added to `post` later is pulled into the table rather than escaping it by being new.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — what post writes is what the stream holds', () => {
  const parents: Array<[string, string | undefined]> = [
    ['a reply', '1700-3'],
    ['a top-level post', undefined],
  ];

  it.each(parents)('%s carries every declared field and no others', async (_label, parent) =>
    withPlugin({}, ({ plugin, prefix }) =>
      withWriter(async (writer) => {
        const t = freshTopic();
        const before = Date.now();
        const id = await plugin.post(
          t,
          asHandle('alice'),
          'hello',
          parent === undefined ? undefined : { inReplyTo: asBackendMsgId(parent) },
        );
        const after = Date.now();

        const [entry] = await writer.xRange(`${prefix}${t}`, id, id);
        const fields = entry?.message ?? {};
        const expected: Record<string, (value: string) => void> = {
          sender: (v) => expect(v).toBe('alice'),
          content: (v) => expect(v).toBe('hello'),
          ts: (v) => {
            expect(v, 'ts is not in ISO 8601 form (DESIGN §5)').toBe(
              new Date(Date.parse(v)).toISOString(),
            );
            expect(Date.parse(v)).toBeGreaterThanOrEqual(before - 1000);
            expect(Date.parse(v)).toBeLessThanOrEqual(after + 1000);
          },
          in_reply_to: (v) =>
            expect(v, 'the seam threading argument was dropped on the floor').toBe(parent ?? ''),
        };

        expect(
          Object.keys(fields).sort(),
          'a field post writes has no declared expectation here (or a declared one never arrived)',
        ).toEqual(Object.keys(expected).sort());
        for (const [field, assertValue] of Object.entries(expected)) {
          assertValue(fields[field] ?? '');
        }
      }),
    ),
  );
});

// -------------------------------------------------------------------------------------------
// CLASS: a cursor's PROVENANCE decides the outcome — mine works, foreign throws labelled,
// beyond-high-water self-heals. The wedge invariant below catches the whole class at once.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — cursor provenance', () => {
  const foreign = [
    ['a matrix-style token', 's123_456'],
    ['a plain word', 'abc'],
    ['the empty string', ''],
    ['the XREAD tail sigil', '$'],
    ['a three-part id', '0-0-0'],
    ['a non-numeric sequence', '12-a'],
    ['a negative id', '-1'],
    ['a float', '12.5'],
    ['an id with whitespace', ' 12-0'],
    // All-digit, so the syntax check alone passes them — but each component of a stream id is a
    // uint64, so these reach XRANGE as a bare `ERR Invalid stream ID` naming neither plugin nor topic.
    ['a 64-bit overflow in the ms component', '99999999999999999999'],
    ['exactly 2^64 in the ms component', '18446744073709551616-0'],
    ['a 64-bit overflow in the sequence', '1-99999999999999999999'],
    ['both components overflowing', '18446744073709551616-18446744073709551616'],
  ] as const;

  it.each(foreign)('throws a labelled error for %s', async (_label, since) =>
    withPlugin({}, async ({ plugin }) => {
      const t = freshTopic();
      await plugin.post(t, asHandle('w'), 'one');
      await expect(plugin.fetchRecent({ topic: t, since: asCursor(since) })).rejects.toThrow(
        new RegExp(`parley-redis: malformed cursor .* for topic ${t}`),
      );
    }));
});

// -------------------------------------------------------------------------------------------
// CLASS: a cursor that sorts past the stream's last generated id must SELF-HEAL — both halves of
// it. Echoing the dead cursor back wedges the topic forever: every later fetch returns the same
// empty page, with no error to retry and no signal to distinguish it from "nothing new".
//
// Two axes, because each one hides a different half of the heal from a one-dimensional table:
//   * STREAM STATE. Rows that post first can only ever grade the QUERY half — an empty page is
//     already a failure, so whether the RETURNED cursor was reset never matters. On a stream with no
//     entries the returned cursor is the only observable, and it is the half that wedges.
//   * ID COMPONENT. A cursor that differs from the tail only in its SEQUENCE exercises the second
//     half of the id comparison, which a table of "an hour ahead" rows never reaches. The ids are
//     written explicitly, so two entries share one millisecond deterministically rather than by luck.
//
// The graded invariant is "no well-formed cursor EVER dead-ends", not one heal outcome: a row that
// throws fails the same way a row that echoes the cursor back does. That is what makes the ceiling
// shapes below meaningful — they are derived from the uint64 bound each id component is, rather
// than hand-picked, because a hand-picked ceiling value samples whichever spelling the server
// happens to accept and grades a narrower class than the one it names.
//
//   * SPELLING. A stream entry id has more than one spelling, and `assertMintedCursor` calls every
//     one of them well-formed, so core rethrows whatever a guard refuses. Shapes built from
//     `BigInt.toString()` can only ever produce the spelling the plugin mints itself, which grades
//     every boundary guard exclusively against its own output — and a guard that compares a cursor
//     by STRING passes that grading while a leading zero walks straight past it.
// -------------------------------------------------------------------------------------------

interface Tail {
  ms: bigint;
  seq: bigint;
}

const tailOf = (id: string): Tail => {
  const [ms = '0', seq = '0'] = id.split('-');
  return { ms: BigInt(ms), seq: BigInt(seq) };
};

/** The same entry id, written with `msZeros`/`seqZeros` leading zeros on its components. */
function respell(id: string, msZeros: number, seqZeros: number): string {
  const pad = (part: string, zeros: number): string => `${'0'.repeat(zeros)}${part}`;
  const [ms = '0', seq] = id.split('-');
  return seq === undefined ? pad(ms, msZeros) : `${pad(ms, msZeros)}-${pad(seq, seqZeros)}`;
}

/**
 * Every spelling of one id core can hand back. A bare-ms id has no sequence to pad, so its
 * sequence rows collapse onto the millisecond ones — deliberately, since which components a shape
 * even has is part of what the axis grades.
 */
const spellings: Array<[string, (id: string) => string]> = [
  ['as this backend mints it', (id) => id],
  ['with a leading zero on the millisecond', (id) => respell(id, 1, 0)],
  ['with a leading zero on the sequence', (id) => respell(id, 0, 1)],
  ['zero-padded on both components', (id) => respell(id, 3, 3)],
];

/**
 * A stream state a stale cursor can arrive at: what catch-up must return once healed, and the
 * stream's own LAST GENERATED id. Taking the tail from the state rather than from a fetched cursor is
 * what makes the deleted rows meaningful — an empty page answers `0-0` while the stream's high-water
 * mark is still whatever it minted, and a cursor derived from `0-0` would not be stale at all.
 */
type StreamState = (writer: Writer, key: string) => Promise<{ expected: string[]; tail: Tail }>;

describe.skipIf(!redisUp)('redis failure modes — a cursor past the high-water mark self-heals', () => {
  const seedTwoInOneMillisecond = async (writer: Writer, key: string): Promise<Tail> => {
    const base = Date.now();
    await writer.xAdd(key, `${base}-0`, { sender: 'w', content: 'one' });
    await writer.xAdd(key, `${base}-1`, { sender: 'w', content: 'two' });
    return tailOf(`${base}-1`);
  };

  const dropEntries = async (writer: Writer, key: string): Promise<void> => {
    const ids = (await writer.xRange(key, '-', '+')).map((e) => e.id);
    await writer.xDel(key, ids);
  };

  const states: Array<[string, StreamState]> = [
    [
      'with two entries sharing one millisecond',
      async (writer, key) => ({
        expected: ['one', 'two'],
        tail: await seedTwoInOneMillisecond(writer, key),
      }),
    ],
    ['never posted to', async () => ({ expected: [], tail: tailOf('0-0') })],
    [
      'whose entries were all deleted',
      async (writer, key) => {
        const tail = await seedTwoInOneMillisecond(writer, key);
        await dropEntries(writer, key);
        return { expected: [], tail };
      },
    ],
    [
      'whose key was deleted mid-session',
      async (writer, key) => {
        await seedTwoInOneMillisecond(writer, key);
        await writer.del(key);
        return { expected: [], tail: tailOf('0-0') };
      },
    ],
  ];

  /** The bound each component of a stream entry id is held to; every ceiling shape derives from it. */
  const CEILING = 2n ** 64n - 1n;

  /** Cursor shapes that sort past any tail these states can produce. */
  const shapes: Array<[string, (tail: Tail) => string]> = [
    ['one sequence past the tail', (t) => `${t.ms}-${t.seq + 1n}`],
    ['one millisecond past the tail', (t) => `${t.ms + 1n}-0`],
    ['an hour past the tail', (t) => `${t.ms + 3_600_000n}-0`],
    ['a bare-ms id past the tail', (t) => `${t.ms + 3_600_000n}`],
    // The inverse of the uint64-overflow rejection rows: every one of these is a well-formed id a
    // stream could in principle hold, so the heal owes each the recent window rather than a
    // rejection. The top of the id space is its own case: `(<max>-<max>` is the one exclusive range
    // start Redis cannot express, so a cursor there reaches XRANGE as a hard refusal.
    ['the ceiling millisecond at sequence zero', () => `${CEILING}-0`],
    ['the ceiling millisecond one below the ceiling sequence', () => `${CEILING}-${CEILING - 1n}`],
    ['the largest id a stream can ever mint', () => `${CEILING}-${CEILING}`],
    ['a bare ceiling millisecond', () => `${CEILING}`],
  ];

  const rows = states.flatMap(([stateLabel, seed]) =>
    shapes.flatMap(([shapeLabel, mint]) =>
      spellings.map(
        ([spellingLabel, respellIt]) =>
          [
            `${shapeLabel} ${spellingLabel}, on a stream ${stateLabel}`,
            seed,
            (tail: Tail) => respellIt(mint(tail)),
          ] as [string, StreamState, (tail: Tail) => string],
      ),
    ),
  );

  it.each(rows)('%s', async (_label, seed, mint) =>
    withPlugin({}, ({ plugin, prefix }) =>
      withWriter(async (writer) => {
        const t = freshTopic();
        const { expected, tail } = await seed(writer, `${prefix}${t}`);
        const since = asCursor(mint(tail));

        // The invariant that catches the whole wedge class, whatever the stream holds: a catch-up
        // must never answer with BOTH an empty page and the same cursor back — that pair is a dead
        // end that repeats forever, and on an EMPTY stream it is the only way the heal can be
        // observed at all.
        const started = Date.now();
        const page = await plugin.fetchRecent({ topic: t, since, blockMs: 2000 });
        expect(page.messages.length > 0 || page.nextCursor !== since).toBe(true);
        expect(page.messages.map((m) => m.content)).toEqual(expected);
        expect(page.nextCursor).not.toBe(since);
        // …and a cursor that can never come true must not burn the granted budget waiting for it.
        expect(Date.now() - started).toBeLessThan(1000);

        // …and the healed cursor is live: it advances over the next post rather than replaying.
        await plugin.post(t, asHandle('w'), 'three');
        const next = await plugin.fetchRecent({ topic: t, since: page.nextCursor });
        expect(next.messages.map((m) => m.content)).toEqual(['three']);
      }),
    ),
  );

  // The other direction of the same comparison, and the one an over-eager heal breaks: a cursor at
  // or BELOW the last generated id names an entry this stream really did mint, so it must be echoed
  // back untouched. Healing it re-delivers the whole retained history as if it were new. Reaching
  // the comparison at all requires an empty XRANGE, so the entries are deleted while the stream (and
  // its last-generated-id) survives — which is what a retention trim leaves behind.
  const belowTailShapes: Array<[string, (tail: Tail) => string]> = [
    ['the tail itself', (t) => `${t.ms}-${t.seq}`],
    ['one sequence below the tail', (t) => `${t.ms}-${t.seq - 1n}`],
    ['one millisecond below the tail', (t) => `${t.ms - 1n}-0`],
  ];

  // Carrying the same spelling axis here is what keeps the fix to the heal honest in BOTH
  // directions: canonicalising a cursor on the way in would satisfy every ceiling row above while
  // silently rewriting a live cursor into one the caller never minted.
  const belowTail = belowTailShapes.flatMap(([shapeLabel, mint]) =>
    spellings.map(
      ([spellingLabel, respellIt]) =>
        [`${shapeLabel} ${spellingLabel}`, (tail: Tail) => respellIt(mint(tail))] as [
          string,
          (tail: Tail) => string,
        ],
    ),
  );

  it.each(belowTail)('echoes a cursor at or below the tail: %s', async (_label, mint) =>
    withPlugin({}, ({ plugin, prefix }) =>
      withWriter(async (writer) => {
        const t = freshTopic();
        const key = `${prefix}${t}`;
        const tail = await seedTwoInOneMillisecond(writer, key);
        await dropEntries(writer, key);
        const since = asCursor(mint(tail));

        const page = await plugin.fetchRecent({ topic: t, since });
        expect(page.messages).toEqual([]);
        expect(
          page.nextCursor,
          'a live cursor was healed, so the next catch-up replays the whole history',
        ).toBe(since);
      }),
    ),
  );

  it('a cursor this backend minted still works, and the tail still returns a stable page', async () =>
    withPlugin({}, async ({ plugin }) => {
      const t = freshTopic();
      await plugin.post(t, asHandle('w'), 'one');
      const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;
      await plugin.post(t, asHandle('w'), 'two');
      const after = await plugin.fetchRecent({ topic: t, since: tail });
      expect(after.messages.map((m) => m.content)).toEqual(['two']);
      // At the tail: empty page, cursor unchanged — the ONE case where echoing `since` is right.
      const drained = await plugin.fetchRecent({ topic: t, since: after.nextCursor });
      expect(drained.messages).toEqual([]);
      expect(drained.nextCursor).toBe(after.nextCursor);
    }));
});

// -------------------------------------------------------------------------------------------
// CLASS: a backend refusal escapes the seam as a bare RESP line naming neither the plugin, the
// topic nor the key. The key namespace is shared with whatever else uses this Redis, so a prefix
// collision is the ordinary way to reach it: an operator whose bridge will not start gets
// `WRONGTYPE Operation against a key holding the wrong kind of value` and nothing to trace it by.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — every seam call labels a backend refusal', () => {
  const calls: Array<[string, (p: RedisPlugin, t: Topic) => Promise<unknown>]> = [
    ['post', (p, t) => p.post(t, asHandle('w'), 'x')],
    ['fetchRecent', (p, t) => p.fetchRecent({ topic: t })],
    ['fetchRecent since', (p, t) => p.fetchRecent({ topic: t, since: asCursor('1-0') })],
    [
      'fetchRecent blocking',
      (p, t) => p.fetchRecent({ topic: t, since: asCursor('1-0'), blockMs: 500 }),
    ],
    ['subscribe', (p, t) => p.subscribe(t, () => undefined)],
  ];

  it.each(calls)('%s names the plugin, the topic and the key', async (_label, call) =>
    withPlugin({}, ({ plugin, prefix }) =>
      withWriter(async (squatter) => {
        const t = freshTopic();
        // A plain string where the stream would live — what a prefix shared with another app
        // looks like.
        await squatter.set(`${prefix}${t}`, 'owned by another application');
        const failure = await call(plugin, t).then(
          () => undefined,
          (err: Error) => err,
        );
        expect(failure, 'a repurposed key was not reported at all').toBeInstanceOf(Error);
        expect(failure?.message).toMatch(/^parley-redis:/);
        expect(failure?.message, 'the operator cannot tell WHICH topic failed').toContain(t);
        expect(failure?.message, 'the operator cannot tell which Redis key failed').toContain(
          `${prefix}${t}`,
        );
        expect(failure?.message).toContain('WRONGTYPE');
      }),
    ),
  );
});
