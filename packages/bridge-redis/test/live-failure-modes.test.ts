import net from 'node:net';
import { asHandle, type Cursor, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, createRedisClient, DEFAULT_URL, RedisPlugin } from '../src/index.js';
import { label, rejectedByKnob } from './config-fixtures.js';
import {
  endpointOf,
  FAST_MS as FAST,
  freshPrefix,
  freshTopic as mintTopic,
  isRedisUp,
  REDIS_URL,
  wipe,
} from './support.js';

// The half of the failure surface that needs a real server. EVERY block here is gated on `redisUp`
// and nothing in this file is ungated, so a Redis that failed to come up makes the whole file skip —
// which the CI whole-file skip gate fails the build on. Keep it that way: one ungated case here
// turns a missing server back into a green file with half its coverage silently deleted.

const freshTopic = (): Topic => mintTopic('lfm');

const redisUp = await isRedisUp(REDIS_URL);

async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<'resolved' | 'rejected'> {
  const timeout = Symbol('timeout');
  const outcome = await Promise.race([
    work.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<typeof timeout>((r) => setTimeout(() => r(timeout), ms)),
  ]);
  if (outcome === timeout) throw new Error(`did not settle within ${ms}ms`);
  return outcome;
}

function asCursorish(s: string): Cursor {
  return s as unknown as Cursor;
}

// The inverse half of the validation class (the rejection matrix lives in failure-modes.test.ts): a
// value the docs call "unset" must still be accepted, or the validators have merely traded a silent
// misconfiguration for a config file that cannot load at all.

/**
 * What `null` must mean, per declared knob. Every knob but `url` is graded against the endpoint under
 * test; `url: null` selects the plugin's OWN default endpoint, which is NOT the one `PARLEY_REDIS_URL`
 * names — the override the README documents, and which the README's `--requirepass` guidance forces
 * you to use — so it is graded on clearing validation and falling back to that default instead.
 */
const nullOutcome: Record<string, 'connects' | 'falls back to the default endpoint'> = {
  url: 'falls back to the default endpoint',
  key_prefix: 'connects',
  block_ms: 'connects',
  connect_timeout_ms: 'connects',
  retention_days: 'connects',
};

describe.skipIf(!redisUp)('redis failure modes — an omitted-as-null knob still connects', () => {
  it.each(CONFIG_KEYS)('connect() accepts %s set to null', async (knob) => {
    const outcome = nullOutcome[knob];
    expect(outcome, `no null outcome is declared for '${knob}'`).toBeDefined();
    const plugin = new RedisPlugin();
    try {
      const failure = await plugin
        .connect({ ...(knob === 'url' ? {} : { url: REDIS_URL }), [knob]: null })
        .then(
          () => undefined,
          (err: Error) => err,
        );
      expect(failure?.message ?? '', `${knob}: null was rejected by validation`).not.toMatch(
        new RegExp(`parley-redis: ${knob} must|unknown backend_config key`),
      );
      if (outcome === 'connects') expect(failure).toBeUndefined();
      else if (failure !== undefined) expect(failure.message).toContain(endpointOf(DEFAULT_URL));
    } finally {
      await plugin.disconnect().catch(() => undefined);
    }
  });
});

describe.skipIf(!redisUp)('redis failure modes — retention_days keeps history when unset', () => {
  const accepted: Array<[string, number | null | undefined]> = [
    ['omitted', undefined],
    ['null (DESIGN §11 "unset")', null],
    ['a real window', 7],
  ];

  it.each(accepted)('%s keeps every posted message', async (_label, value) => {
    const prefix = freshPrefix();
    const plugin = new RedisPlugin();
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix, retention_days: value });
    const t = freshTopic();
    try {
      for (let i = 0; i < 40; i++) await plugin.post(t, asHandle('w'), `m${i}`);
      await new Promise((r) => setTimeout(r, 250)); // any wall-clock-threshold trim would bite here
      for (let i = 40; i < 45; i++) await plugin.post(t, asHandle('w'), `m${i}`);
      const page = await plugin.fetchRecent({ topic: t, limit: 10_000 });
      expect(page.messages).toHaveLength(45);
      expect(page.messages[0]?.content).toBe('m0');
    } finally {
      await plugin.disconnect();
      await wipe(prefix);
    }
  });
});

// -------------------------------------------------------------------------------------------
// The inverse half of the knob class, and the half that actually catches a silent no-op: a value
// connect() ACCEPTS must leave every seam path working. Rejecting bad values is not enough — a knob
// that merely fails to be rejected can still make EVERY write fail behind a connect() that resolved,
// or disable live push, with nothing to see at load time.
//
// GENERATED per knob, not hand-picked: `retention_days` reaches XADD as `days * 86_400_000`, so
// whether a value works depends on its BINARY REPRESENTATION rather than its magnitude, and a fixed
// row can only ever sample the values that happen to land on a whole millisecond. One wide row per
// knob, so a failure names the offending value instead of hiding among green siblings.
// -------------------------------------------------------------------------------------------

/** Deterministic LCG, so a value that breaks the seam is reproducible on a re-run, not once in 50. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Retention windows the validator accepts: small rationals (rarely whole ms) plus random floats. */
function retentionWindows(): number[] {
  const out: number[] = [0.5, 7, 30];
  for (let denom = 2; denom <= 13; denom++) {
    for (const numer of [1, denom + 1, 30]) out.push(numer / denom);
  }
  const rnd = seeded(0x5eed);
  for (let i = 0; i < 40; i++) out.push(0.001 + rnd() * 60);
  return out;
}

/** Whole-millisecond budgets in [lo, hi) — the only shape either millisecond knob accepts. */
function millisBudgets(seed: number, lo: number, hi: number): number[] {
  const rnd = seeded(seed);
  return Array.from({ length: 20 }, () => lo + Math.floor(rnd() * (hi - lo)));
}

/**
 * Values `connect()` accepts, per declared knob. Driven from CONFIG_KEYS below, so a knob added later
 * with no accepted-value set fails here instead of shipping a value nobody ever round-tripped.
 * `connect_timeout_ms` starts at 500, so that a budget shorter than a real handshake — a LOUD
 * rejection the operator asked for, not the silent breakage this class is about — stays out.
 */
const acceptedByKnob: Record<string, unknown[]> = {
  url: [REDIS_URL],
  key_prefix: ['plain:', 'no-trailing-colon', 'with spaces:', 'unicode-\u00fc:', 'glob*chars?:'].map(
    (flavour) => `${freshPrefix()}${flavour}`,
  ),
  retention_days: [null, ...retentionWindows()],
  block_ms: [1, 2000, 120_000, ...millisBudgets(0xb10c, 1, 600_000)],
  connect_timeout_ms: [5000, ...millisBudgets(0xc0de, 500, 30_000)],
};

describe.skipIf(!redisUp)('redis failure modes — an accepted config still delivers', () => {
  it.each(CONFIG_KEYS)('every accepted %s round-trips post → fetchRecent', async (knob) => {
    const values = acceptedByKnob[knob] ?? [];
    expect(values.length, `no accepted values are declared for '${knob}'`).toBeGreaterThan(0);
    const plugin = new RedisPlugin();
    const prefixes = new Set<string>();
    const broken: string[] = [];
    try {
      for (const value of values) {
        const config: Record<string, unknown> = {
          url: REDIS_URL,
          key_prefix: freshPrefix(),
          [knob]: value,
        };
        prefixes.add(String(config.key_prefix));
        const t = freshTopic();
        const failure = await (async () => {
          await plugin.connect(config);
          const id = await plugin.post(t, asHandle('w'), 'round-trip');
          const page = await plugin.fetchRecent({ topic: t, limit: 10 });
          if (page.messages.map((m) => m.backendMsgId).join() !== id) {
            throw new Error(`fetchRecent returned ${JSON.stringify(page.messages)}`);
          }
        })().then(
          () => undefined,
          (err: Error) => err,
        );
        if (failure !== undefined) broken.push(`${label(value)} → ${failure.message}`);
      }
      expect(broken, `connect() accepted these ${knob} values and then broke the seam`).toEqual([]);
    } finally {
      await plugin.disconnect().catch(() => undefined);
      for (const prefix of prefixes) await wipe(prefix);
    }
  });

  // The one path the round-trip above cannot see: a knob accepted at connect() that then silently
  // kills LIVE push. `30 / 7` is deliberate — a window that is not a whole number of milliseconds.
  it('live push still works with every knob set at once', async () => {
    const prefix = freshPrefix();
    const plugin = new RedisPlugin();
    await plugin.connect({
      url: REDIS_URL,
      key_prefix: prefix,
      block_ms: 250,
      connect_timeout_ms: 3000,
      retention_days: 30 / 7,
    });
    const t = freshTopic();
    const live: string[] = [];
    try {
      await plugin.subscribe(t, (m) => live.push(m.content));
      const id = await plugin.post(t, asHandle('w'), 'pushed');
      await expect.poll(() => live, { timeout: 5000, interval: 50 }).toEqual(['pushed']);
      const page = await plugin.fetchRecent({ topic: t, limit: 10 });
      expect(page.messages.map((m) => m.backendMsgId)).toEqual([id]);
    } finally {
      await plugin.disconnect();
      await wipe(prefix);
    }
  });
});

// The teardown-ordering half of the same class: connect() validates its WHOLE config before it tears
// the previous connection down, so a value an operator got wrong can never leave a live bridge with
// no client and every later seam call answering "not connected". Driven over every rejection row of
// every knob, because the ordering is a property of connect() rather than of any one knob.

describe.skipIf(!redisUp)(
  'redis failure modes — a rejected connect() must not destroy a live one',
  () => {
    it.each(CONFIG_KEYS)('every rejected %s leaves the live connection usable', async (knob) => {
      const rows = rejectedByKnob[knob] ?? [];
      expect(rows.length, `no rejection rows are declared for '${knob}'`).toBeGreaterThan(0);
      const prefix = freshPrefix();
      const plugin = new RedisPlugin();
      await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
      const t = freshTopic();
      const destroyed: string[] = [];
      try {
        await plugin.post(t, asHandle('w'), 'before');
        for (const [rowLabel, value] of rows) {
          const rejection = await plugin
            .connect({ url: REDIS_URL, key_prefix: prefix, [knob]: value })
            .then(
              () => undefined,
              (err: Error) => err,
            );
          if (rejection === undefined) {
            destroyed.push(`${rowLabel}: accepted, so this row proves nothing`);
            continue;
          }
          const survived = await plugin.post(t, asHandle('w'), rowLabel).then(
            () => true,
            () => false,
          );
          if (!survived) destroyed.push(`${rowLabel}: ${rejection.message}`);
        }
        expect(
          destroyed,
          `a rejected ${knob} tore the live connection down before finishing validation`,
        ).toEqual([]);
        const page = await plugin.fetchRecent({ topic: t, limit: 1000 });
        expect(page.messages.map((m) => m.content)).toContain('before');
      } finally {
        await plugin.disconnect().catch(() => undefined);
        await wipe(prefix);
      }
    });
  },
);

// -------------------------------------------------------------------------------------------
// CLASS: a record this plugin did not write still has to normalize into a valid Message. Streams
// are shared across sessions, plugin versions and anyone holding a redis-cli, so `sender`/`ts`
// are not guaranteed to be there — and DESIGN §5 promises an ISO timestamp and a sender either way.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — entries written by a foreign writer', () => {
  // Every row declares the timestamp it must DERIVE, not merely that one parses: an assertion of the
  // form `!Number.isNaN(Date.parse(ts))` is satisfied by any constant, so replacing the derivation
  // with `new Date(0)` would report 1970 for every message and the suite would certify it.
  // `from-id` = the stream id's own millisecond component; `passthrough` = the entry's `ts` verbatim.
  type Derivation = 'from-id' | 'passthrough';
  const foreignEntries: Array<[string, Record<string, string>, Derivation]> = [
    ['no recognised field at all', { unrelated: '1' }, 'from-id'],
    ['content only (a human via redis-cli)', { content: 'hi from redis-cli' }, 'from-id'],
    ['sender only', { sender: 'alice' }, 'from-id'],
    ['an empty sender', { sender: '', content: 'anon' }, 'from-id'],
    // One row per DERIVATION, not one per unusable spelling: an empty `ts`, `not-a-date` and a bare
    // epoch number all take the same fallback, so extra spellings cannot fail for their own reason.
    ['a ts that is not a date', { sender: 'alice', content: 'hi', ts: 'not-a-date' }, 'from-id'],
    ['a ts of its own', { sender: 'a', content: 'hi', ts: '2020-05-06T07:08:09.000Z' }, 'passthrough'],
    ['extra unknown fields', { sender: 'alice', content: 'hi', shape: 'm.text', edited: '1' }, 'from-id'],
    ['binary-ish content', { sender: 'alice', content: '\u00ff\u00fe\u0001bin' }, 'from-id'],
  ];

  it.each(foreignEntries)('normalizes an entry with %s', async (_label, fields, derivation) => {
    const prefix = freshPrefix();
    const plugin = new RedisPlugin();
    const writer = createRedisClient(REDIS_URL, FAST);
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
    const t = freshTopic();
    try {
      await writer.connect();
      const id = await writer.xAdd(`${prefix}${t}`, '*', fields);
      const page = await plugin.fetchRecent({ topic: t, limit: 10 });
      const [m] = page.messages;
      expect(m, 'the foreign entry did not come back at all').toBeDefined();
      expect(m?.topic).toBe(t);
      expect(m?.backendMsgId).toBe(id);
      expect(m?.cursor).toBe(id);
      expect(m?.content).toBe(fields.content ?? '');
      expect(m?.senderHandle, 'an empty handle collides with every other empty handle').not.toBe('');
      const expected =
        derivation === 'passthrough' ? fields.ts : new Date(Number(id.split('-')[0])).toISOString();
      expect(m?.timestamp, `timestamp is not derived ${derivation}`).toBe(expected);
      expect(
        Number.isNaN(Date.parse(m?.timestamp ?? '')),
        `timestamp ${JSON.stringify(m?.timestamp)} is not ISO 8601 (DESIGN §5)`,
      ).toBe(false);
    } finally {
      await writer.disconnect().catch(() => undefined);
      await plugin.disconnect();
      await wipe(prefix);
    }
  });

  // The inverse half: an entry this plugin wrote must report the wall-clock time of the post. Only a
  // bracketed window can say so — every other assertion on Message.timestamp here and in the shared
  // conformance suite tests parseability, which any constant satisfies.
  it('reports the wall-clock time of a post it made itself', async () => {
    const prefix = freshPrefix();
    const plugin = new RedisPlugin();
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
    const t = freshTopic();
    try {
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
    } finally {
      await plugin.disconnect();
      await wipe(prefix);
    }
  });

  it('normalizes a foreign entry arriving over the LIVE path too', async () => {
    const prefix = freshPrefix();
    const plugin = new RedisPlugin();
    const writer = createRedisClient(REDIS_URL, FAST);
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
    const t = freshTopic();
    const live: Array<{ senderHandle: string; timestamp: string }> = [];
    try {
      await writer.connect();
      await plugin.subscribe(t, (m) => live.push(m));
      await writer.xAdd(`${prefix}${t}`, '*', { content: 'from redis-cli' });
      await expect.poll(() => live.length, { timeout: 5000, interval: 50 }).toBe(1);
      expect(live[0]?.senderHandle).not.toBe('');
      expect(Number.isNaN(Date.parse(live[0]?.timestamp ?? ''))).toBe(false);
    } finally {
      await writer.disconnect().catch(() => undefined);
      await plugin.disconnect();
      await wipe(prefix);
    }
  });
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

  it.each(foreign)('throws a labelled error for %s', async (_label, since) => {
    const prefix = freshPrefix();
    const plugin = new RedisPlugin();
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
    const t = freshTopic();
    try {
      await plugin.post(t, asHandle('w'), 'one');
      await expect(
        plugin.fetchRecent({ topic: t, since: since as unknown as Cursor }),
      ).rejects.toThrow(new RegExp(`parley-redis: malformed cursor .* for topic ${t}`));
    } finally {
      await plugin.disconnect();
      await wipe(prefix);
    }
  });
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
// -------------------------------------------------------------------------------------------

interface Tail {
  ms: bigint;
  seq: bigint;
}

const tailOf = (id: string): Tail => {
  const [ms = '0', seq = '0'] = id.split('-');
  return { ms: BigInt(ms), seq: BigInt(seq) };
};

type Writer = ReturnType<typeof createRedisClient>;

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

  /** Cursor shapes that sort past any tail these states can produce. */
  const shapes: Array<[string, (tail: Tail) => string]> = [
    ['one sequence past the tail', (t) => `${t.ms}-${t.seq + 1n}`],
    ['one millisecond past the tail', (t) => `${t.ms + 1n}-0`],
    ['an hour past the tail', (t) => `${t.ms + 3_600_000n}-0`],
    ['a bare-ms id past the tail', (t) => `${t.ms + 3_600_000n}`],
    // The inverse of the uint64-overflow rejection rows: 2^64-1 is the largest id Redis can mint, so
    // the range check must heal it like any other future cursor rather than reject it as malformed.
    ['the largest id a stream can ever mint', () => '18446744073709551615-0'],
  ];

  const rows = states.flatMap(([stateLabel, seed]) =>
    shapes.map(
      ([shapeLabel, mint]) =>
        [`${shapeLabel}, on a stream ${stateLabel}`, seed, mint] as [
          string,
          StreamState,
          (tail: Tail) => string,
        ],
    ),
  );

  it.each(rows)('%s', async (_label, seed, mint) => {
    const prefix = freshPrefix();
    const plugin = new RedisPlugin();
    const writer = createRedisClient(REDIS_URL, FAST);
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
    const t = freshTopic();
    try {
      await writer.connect();
      const { expected, tail } = await seed(writer, `${prefix}${t}`);
      const since = mint(tail) as Cursor;

      // The invariant that catches the whole wedge class, whatever the stream holds: a catch-up must
      // never answer with BOTH an empty page and the same cursor back — that pair is a dead end that
      // repeats forever, and on an EMPTY stream it is the only way the heal can be observed at all.
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
    } finally {
      await writer.disconnect().catch(() => undefined);
      await plugin.disconnect();
      await wipe(prefix);
    }
  });

  // The other direction of the same comparison, and the one an over-eager heal breaks: a cursor at
  // or BELOW the last generated id names an entry this stream really did mint, so it must be echoed
  // back untouched. Healing it re-delivers the whole retained history as if it were new. Reaching
  // the comparison at all requires an empty XRANGE, so the entries are deleted while the stream (and
  // its last-generated-id) survives — which is what a retention trim leaves behind.
  const belowTail: Array<[string, (tail: Tail) => string]> = [
    ['the tail itself', (t) => `${t.ms}-${t.seq}`],
    ['one sequence below the tail', (t) => `${t.ms}-${t.seq - 1n}`],
    ['one millisecond below the tail', (t) => `${t.ms - 1n}-0`],
  ];

  it.each(belowTail)('echoes a cursor at or below the tail: %s', async (_label, mint) => {
    const prefix = freshPrefix();
    const plugin = new RedisPlugin();
    const writer = createRedisClient(REDIS_URL, FAST);
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
    const t = freshTopic();
    const key = `${prefix}${t}`;
    try {
      await writer.connect();
      const tail = await seedTwoInOneMillisecond(writer, key);
      await dropEntries(writer, key);
      const since = mint(tail) as Cursor;

      const page = await plugin.fetchRecent({ topic: t, since });
      expect(page.messages).toEqual([]);
      expect(
        page.nextCursor,
        'a live cursor was healed, so the next catch-up replays the whole history',
      ).toBe(since);
    } finally {
      await writer.disconnect().catch(() => undefined);
      await plugin.disconnect();
      await wipe(prefix);
    }
  });

  it('a cursor this backend minted still works, and the tail still returns a stable page', async () => {
    const prefix = freshPrefix();
    const plugin = new RedisPlugin();
    await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
    const t = freshTopic();
    try {
      await plugin.post(t, asHandle('w'), 'one');
      const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;
      await plugin.post(t, asHandle('w'), 'two');
      const after = await plugin.fetchRecent({ topic: t, since: tail });
      expect(after.messages.map((m) => m.content)).toEqual(['two']);
      // At the tail: empty page, cursor unchanged — the ONE case where echoing `since` is right.
      const drained = await plugin.fetchRecent({ topic: t, since: after.nextCursor });
      expect(drained.messages).toEqual([]);
      expect(drained.nextCursor).toBe(after.nextCursor);
    } finally {
      await plugin.disconnect();
      await wipe(prefix);
    }
  });
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
    ['fetchRecent since', (p, t) => p.fetchRecent({ topic: t, since: asCursorish('1-0') })],
    [
      'fetchRecent blocking',
      (p, t) => p.fetchRecent({ topic: t, since: asCursorish('1-0'), blockMs: 500 }),
    ],
    ['subscribe', (p, t) => p.subscribe(t, () => undefined)],
  ];

  it.each(calls)('%s names the plugin, the topic and the key', async (_label, call) => {
    const prefix = freshPrefix();
    const t = freshTopic();
    const squatter = createRedisClient(REDIS_URL, FAST);
    const plugin = new RedisPlugin();
    try {
      await squatter.connect();
      // A plain string where the stream would live — what a prefix shared with another app looks like.
      await squatter.set(`${prefix}${t}`, 'owned by another application');
      await plugin.connect({ url: REDIS_URL, key_prefix: prefix });
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
    } finally {
      await squatter.disconnect().catch(() => undefined);
      await plugin.disconnect().catch(() => undefined);
      await wipe(prefix);
    }
  });
});

// -------------------------------------------------------------------------------------------
// CLASS: a message that lands in the gap between the catch-up query and the moment the waiter is
// armed is lost. The conformance long-poll case posts well after the fetch has registered, so it
// can never discriminate; every row here starts the post WITHOUT awaiting the fetch, so the write
// lands while the reader is still opening its connection — the arm-after-the-re-query defect.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — the long-poll query-to-wait gap', () => {
  // Only delays SHORTER than a reader handshake belong here. A longer one lands after the waiter
  // has registered, where the shipped conformance long-poll case already pins delivery, so it would
  // pass against the very defect this block exists to catch.
  it.each([0, 1, 2, 3])(
    'delivers a post issued %ims into the long-poll',
    async (delayMs) => {
      const prefix = freshPrefix();
      const plugin = new RedisPlugin();
      await plugin.connect({ url: REDIS_URL, key_prefix: prefix, block_ms: 500 });
      const t = freshTopic();
      try {
        await plugin.post(t, asHandle('w'), 'seed');
        const since = (await plugin.fetchRecent({ topic: t })).nextCursor;

        const waiting = plugin.fetchRecent({ topic: t, since, blockMs: 5000 });
        const posted = new Promise<void>((r) => setTimeout(r, delayMs)).then(() =>
          plugin.post(t, asHandle('w'), 'fresh'),
        );

        const page = await waiting;
        await posted;
        expect(
          page.messages.map((m) => m.content),
          'the post landed in the query-to-wait gap and was never delivered',
        ).toEqual(['fresh']);
        expect(page.nextCursor).not.toBe(since);

        // …and the returned cursor is the one the next catch-up must resume from: re-fetching with
        // it returns nothing, so no message was skipped over on the way to it either.
        const after = await plugin.fetchRecent({ topic: t, since: page.nextCursor });
        expect(after.messages).toEqual([]);
      } finally {
        await plugin.disconnect();
        await wipe(prefix);
      }
    },
  );

  // CLASS: the sub-millisecond long-poll budget. `blockMs` is typed `number`, so 0.5 clears `> 0`
  // and floors to 0 — and `XREAD BLOCK 0` blocks FOREVER. The floor lives in exactly one place, so
  // grade it by its observable effect on BOTH sides: a budget that floors to nothing must open no
  // reader at all, and a budget that survives the floor must actually open one and wait.
  const budgets: Array<[string, number, 'no reader' | 'blocks']> = [
    ['0.1', 0.1, 'no reader'],
    ['0.5', 0.5, 'no reader'],
    ['0.999', 0.999, 'no reader'],
    ['1', 1, 'blocks'],
    ['400', 400, 'blocks'],
  ];

  it.each(budgets)('a blockMs of %s opens a reader only when it survives the floor', async (
    _label,
    blockMs,
    outcome,
  ) => {
    const proxy = await startProxy();
    const prefix = freshPrefix();
    const plugin = new RedisPlugin();
    await plugin.connect({ url: proxy.url, key_prefix: prefix });
    const t = freshTopic();
    try {
      await plugin.post(t, asHandle('w'), 'seed');
      const since = (await plugin.fetchRecent({ topic: t })).nextCursor;
      const before = proxy.accepted();

      const started = Date.now();
      const page = await plugin.fetchRecent({ topic: t, since, blockMs });
      const elapsed = Date.now() - started;

      expect(page.messages).toEqual([]);
      expect(page.nextCursor).toBe(since);
      expect(elapsed, 'a sub-millisecond budget must never reach XREAD BLOCK 0').toBeLessThan(
        blockMs + 2000,
      );
      const readers = proxy.accepted() - before;
      if (outcome === 'no reader') {
        expect(readers, `a budget of ${blockMs} floors to nothing, so no reader is owed`).toBe(0);
      } else {
        expect(readers, `a budget of ${blockMs} was granted but no reader ever opened`).toBe(1);
        expect(elapsed, `a granted budget of ${blockMs}ms returned early`).toBeGreaterThanOrEqual(
          blockMs,
        );
      }
    } finally {
      await plugin.disconnect().catch(() => undefined);
      proxy.close();
      await wipe(prefix);
    }
  });
});

// -------------------------------------------------------------------------------------------
// CLASS: every seam call must SETTLE within a bounded deadline while the backend is down, and
// the plugin must recover when it comes back.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — backend down mid-session', () => {
  it.each([
    ['post', (p: RedisPlugin, t: Topic) => p.post(t, asHandle('w'), 'during')],
    ['fetchRecent', (p: RedisPlugin, t: Topic) => p.fetchRecent({ topic: t })],
    [
      'fetchRecent since',
      (p: RedisPlugin, t: Topic) => p.fetchRecent({ topic: t, since: asCursorish('1-0') }),
    ],
    [
      'fetchRecent blocking',
      (p: RedisPlugin, t: Topic) =>
        p.fetchRecent({ topic: t, since: asCursorish('1-0'), blockMs: 5000 }),
    ],
    ['resolveIdentity', (p: RedisPlugin) => p.resolveIdentity(asHandle('w'))],
    ['subscribe', (p: RedisPlugin, t: Topic) => p.subscribe(t, () => undefined)],
  ] as Array<[string, (p: RedisPlugin, t: Topic) => Promise<unknown>]>)(
    '%s settles instead of queueing for the whole outage',
    async (_label, call) => {
      const proxy = await startProxy();
      const prefix = freshPrefix();
      const plugin = new RedisPlugin();
      await plugin.connect({ url: proxy.url, key_prefix: prefix, connect_timeout_ms: FAST });
      const t = freshTopic();
      try {
        await plugin.post(t, asHandle('w'), 'before');
        proxy.kill();
        await settledOutage(plugin, t);
        // Generous vs. the 5s blocking budget above, brutal vs. "queued for the whole outage".
        await expect(settlesWithin(call(plugin, t), 3000)).resolves.toMatch(
          /resolved|rejected/,
        );
      } finally {
        await plugin.disconnect().catch(() => undefined);
        proxy.close();
        await wipe(prefix);
      }
    },
  );

  it('recovers once the backend comes back', async () => {
    const proxy = await startProxy();
    const prefix = freshPrefix();
    const plugin = new RedisPlugin();
    await plugin.connect({ url: proxy.url, key_prefix: prefix, connect_timeout_ms: FAST });
    const t = freshTopic();
    try {
      await plugin.post(t, asHandle('w'), 'before');
      proxy.kill();
      await settledOutage(plugin, t);
      await expect(settlesWithin(plugin.post(t, asHandle('w'), 'during'), 3000)).resolves.toBe(
        'rejected',
      );
      await proxy.revive();
      await expect
        .poll(
          async () => {
            try {
              await plugin.post(t, asHandle('w'), 'after');
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 10_000, interval: 200 },
        )
        .toBe(true);
      const page = await plugin.fetchRecent({ topic: t, limit: 100 });
      expect(page.messages.map((m) => m.content)).toContain('after');
    } finally {
      await plugin.disconnect().catch(() => undefined);
      proxy.close();
      await wipe(prefix);
    }
  });
});

// -------------------------------------------------------------------------------------------
// CLASS: repeated lifecycle calls must not leak backend resources. Counted on the proxy, which
// is an EXTERNAL observation of live sockets — the in-process `readers` array stays clean even
// when connections are orphaned.
// -------------------------------------------------------------------------------------------

describe.skipIf(!redisUp)('redis failure modes — lifecycle must not leak connections', () => {
  const sequences: Array<[string, (p: RedisPlugin, url: string, t: Topic) => Promise<void>]> = [
    [
      'connect·connect·disconnect',
      async (p, url) => {
        await p.connect({ url });
        await p.connect({ url });
        await p.disconnect();
      },
    ],
    [
      'connect·subscribe·connect·disconnect',
      async (p, url, t) => {
        await p.connect({ url });
        await p.subscribe(t, () => undefined);
        await p.connect({ url });
        await p.disconnect();
      },
    ],
    [
      'connect·disconnect·disconnect',
      async (p, url) => {
        await p.connect({ url });
        await p.disconnect();
        await p.disconnect();
      },
    ],
    [
      'connect·subscribe·disconnect·connect·subscribe·disconnect',
      async (p, url, t) => {
        await p.connect({ url });
        await p.subscribe(t, () => undefined);
        await p.disconnect();
        await p.connect({ url });
        await p.subscribe(t, () => undefined);
        await p.disconnect();
      },
    ],
    [
      'connect·fetchRecent(blocking)·connect·disconnect',
      async (p, url, t) => {
        await p.connect({ url, block_ms: 200 });
        await p.fetchRecent({ topic: t, since: asCursorish('1-0'), blockMs: 200 });
        await p.connect({ url });
        await p.disconnect();
      },
    ],
  ];

  // OVERLAPPING lifecycle calls, which every sequence above misses by construction: each one reads
  // plugin state before the other has written it, so a client can end up referenced by nothing and
  // closeable by nobody. The final disconnect() is the assertion point — after it, zero sockets.
  const overlapping: Array<[string, (p: RedisPlugin, url: string, t: Topic) => Promise<void>]> = [
    [
      'connect ∥ connect',
      async (p, url) => {
        await Promise.allSettled([p.connect({ url }), p.connect({ url })]);
      },
    ],
    [
      'connect ∥ connect ∥ connect',
      async (p, url) => {
        await Promise.allSettled([p.connect({ url }), p.connect({ url }), p.connect({ url })]);
      },
    ],
    [
      'connect ∥ disconnect',
      async (p, url) => {
        await Promise.allSettled([p.connect({ url }), p.disconnect()]);
      },
    ],
    [
      'connect ∥ subscribe',
      async (p, url, t) => {
        await Promise.allSettled([p.connect({ url }), p.subscribe(t, () => undefined)]);
      },
    ],
    [
      'connect·(disconnect ∥ subscribe)',
      async (p, url, t) => {
        await p.connect({ url });
        await Promise.allSettled([p.disconnect(), p.subscribe(t, () => undefined)]);
      },
    ],
    [
      'connect·(connect ∥ fetchRecent(blocking))',
      async (p, url, t) => {
        await p.connect({ url, block_ms: 200 });
        await Promise.allSettled([
          p.connect({ url }),
          p.fetchRecent({ topic: t, since: asCursorish('1-0'), blockMs: 500 }),
        ]);
      },
    ],
  ];

  it.each([...sequences, ...overlapping])('%s returns every socket', async (_label, run) => {
    const proxy = await startProxy();
    const plugin = new RedisPlugin();
    const t = freshTopic();
    try {
      await run(plugin, proxy.url, t);
      await plugin.disconnect();
      await expect.poll(() => proxy.live(), { timeout: 5000, interval: 50 }).toBe(0);
    } finally {
      await plugin.disconnect().catch(() => undefined);
      proxy.close();
    }
  });

  // The reader-open FAILURE paths, which every sequence above misses by construction: their proxy
  // completes every handshake promptly, so `connectReader` never rejects and no error path is ever
  // walked. Here the first connection is a real Redis and every LATER one accepts TCP and then never
  // speaks RESP, so each reader dies on the whole-handshake deadline instead.
  //
  // The mid-session ceiling is the assertion that matters: cleanup that only runs on the success
  // path still passes the after-disconnect check, because tearDown() is a backstop that closes
  // whatever is still registered. Only a per-call ceiling sees a reader accumulate per long-poll.
  const failingReaders: Array<
    [string, (p: RedisPlugin, t: Topic, since: Cursor) => Promise<void>]
  > = [
    [
      'subscribe',
      async (p, t) => {
        await p.subscribe(t, () => undefined).catch(() => undefined);
      },
    ],
    [
      'one blocking fetchRecent',
      async (p, t, since) => {
        await p.fetchRecent({ topic: t, since, blockMs: 2000 });
      },
    ],
    [
      'three blocking fetchRecents',
      async (p, t, since) => {
        for (let i = 0; i < 3; i++) await p.fetchRecent({ topic: t, since, blockMs: 2000 });
      },
    ],
  ];

  it.each(failingReaders)(
    'returns every socket when a reader never finishes its handshake: %s',
    async (_label, run) => {
      const proxy = await startProxy();
      const prefix = freshPrefix();
      const plugin = new RedisPlugin();
      const t = freshTopic();
      try {
        await plugin.connect({ url: proxy.url, key_prefix: prefix, connect_timeout_ms: FAST });
        // A cursor AT the tail is what makes the blocking rows open a reader at all: below the tail
        // XRANGE answers immediately, and past it the stale-cursor heal answers immediately.
        await plugin.post(t, asHandle('w'), 'seed');
        const since = (await plugin.fetchRecent({ topic: t })).nextCursor;
        proxy.stallNewConnections();
        const openedBefore = proxy.accepted();

        const peak = { sockets: 0 };
        const watch = setInterval(() => {
          peak.sockets = Math.max(peak.sockets, proxy.live());
        }, 10);
        try {
          await run(plugin, t, since);
        } finally {
          clearInterval(watch);
        }
        expect(
          proxy.accepted() - openedBefore,
          'no reader was opened at all, so this row grades nothing',
        ).toBeGreaterThan(0);
        expect(
          peak.sockets,
          'a reader that failed its handshake was not returned before the next one opened',
        ).toBeLessThanOrEqual(2);

        await plugin.disconnect();
        await expect.poll(() => proxy.live(), { timeout: 5000, interval: 50 }).toBe(0);
      } finally {
        await plugin.disconnect().catch(() => undefined);
        proxy.close();
        await wipe(prefix);
      }
    },
  );
});

/**
 * Wait out the socket-close error and the first reconnect attempts, so the measured call is issued
 * into a client that has SETTLED into "disconnected" — the state where an offline queue swallows
 * commands for the whole outage. Only the commands in flight when the socket dies are rejected by
 * the close itself, so measuring the very first call after a kill proves nothing.
 */
async function settledOutage(plugin: RedisPlugin, topic: Topic): Promise<void> {
  await settlesWithin(plugin.post(topic, asHandle('w'), 'flush').catch(() => undefined), 3000);
  await new Promise((r) => setTimeout(r, 300));
}

interface Proxy {
  url: string;
  /** Live client sockets currently proxied — the externally observable resource count. */
  live: () => number;
  /** Every client socket ever accepted — how many connections the plugin has OPENED. */
  accepted: () => number;
  /** Stop forwarding: from here on, accept TCP and never speak a word of RESP. */
  stallNewConnections: () => void;
  /** Drop the endpoint the way a crashed server does: stop listening, destroy every socket. */
  kill: () => void;
  revive: () => Promise<void>;
  close: () => void;
}

/**
 * A TCP pass-through in front of the real Redis, so an outage can be simulated per test WITHOUT
 * shutting down a server other suites (and other agents) are using.
 */
async function startProxy(): Promise<Proxy> {
  const target = new URL(REDIS_URL);
  const host = target.hostname;
  const port = target.port === '' ? 6379 : Number(target.port);
  const sockets = new Set<net.Socket>();
  let server: net.Server;
  let listenPort = 0;
  let acceptedCount = 0;
  let stalling = false;

  const build = (): net.Server =>
    net.createServer((client) => {
      acceptedCount++;
      sockets.add(client);
      const teardown = (): void => {
        sockets.delete(client);
        client.destroy();
      };
      client.on('error', teardown).on('close', teardown);
      if (stalling) {
        client.on('data', () => undefined);
        return;
      }
      const upstream = net.connect(port, host);
      const both = (): void => {
        teardown();
        upstream.destroy();
      };
      client.on('error', both).on('close', both);
      upstream.on('error', both).on('close', both);
      client.pipe(upstream);
      upstream.pipe(client);
    });

  server = build();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  listenPort = (server.address() as net.AddressInfo).port;

  const killSockets = (): void => {
    for (const s of sockets) s.destroy();
    sockets.clear();
  };

  return {
    url: `redis://127.0.0.1:${listenPort}`,
    live: () => sockets.size,
    accepted: () => acceptedCount,
    stallNewConnections: () => {
      stalling = true;
    },
    kill: () => {
      server.close();
      killSockets();
    },
    revive: async () => {
      server = build();
      await new Promise<void>((r) => server.listen(listenPort, '127.0.0.1', r));
    },
    close: () => {
      server.close();
      killSockets();
    },
  };
}
