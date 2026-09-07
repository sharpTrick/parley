import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNC_DIAG_INTERVAL_MS, syncFailureReporter } from '../src/diagnostics.js';
import { connectFake, FakeSynapse } from './fake-synapse.js';

/**
 * CLASS: a background loop must not turn a permanent error into a silent infinite retry. A revoked
 * access token (401), a refused read (403), a broken homeserver (500), or a dropped socket all land
 * in the same catch — the loop must recover from the transient ones and, for the permanent ones, say
 * so on stderr and slow down instead of hammering the homeserver forever with a dead live path.
 *
 * Losing membership of the room is NOT in this table and cannot be: `/sync` never answers an error
 * for it. That shape is graded at the end of this file.
 */

const FAILURES = {
  '401 (revoked token)': { mode: 'status', status: 401 },
  '403 (the homeserver refuses the read)': { mode: 'status', status: 403 },
  '500 (homeserver fault)': { mode: 'status', status: 500 },
  'network reject': { mode: 'network', status: 0 },
} as const;

let fake: FakeSynapse;
beforeEach(() => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const arm = (kind: keyof typeof FAILURES, count: number): void => {
  const f = FAILURES[kind];
  fake.syncFailureMode = f.mode;
  fake.syncFailureStatus = f.status;
  fake.syncFailures = count;
};

describe('subscribe loop survives a transient /sync failure', () => {
  for (const kind of Object.keys(FAILURES) as (keyof typeof FAILURES)[]) {
    it(`${kind}: recovers after 3 failures and still delivers`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const p = await connectFake({});
      const t = asTopic('resilient');
      const got: string[] = [];
      await p.subscribe(t, (m) => got.push(m.content));
      arm(kind, 3);
      fake.addMessage(String(t), 'after-the-outage');

      await vi.waitFor(() => expect(got).toEqual(['after-the-outage']), {
        timeout: 8000,
        interval: 20,
      });
      await p.disconnect();
    }, 20_000);
  }
});

/** The `(N consecutive; …)` counts a run reported on stderr, in order. */
const reportedFailureCounts = (calls: unknown[][]): number[] =>
  calls
    .map((c) => /\((\d+) consecutive;/.exec(String(c[0]))?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);

describe('subscribe loop does not silently hot-retry a permanent /sync failure', () => {
  for (const kind of Object.keys(FAILURES) as (keyof typeof FAILURES)[]) {
    it(`${kind}: reports it on stderr, throttled, and backs off`, async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const p = await connectFake({});
      arm(kind, Number.POSITIVE_INFINITY);
      await p.subscribe(asTopic('doomed'), () => undefined);

      await vi.waitFor(() => expect(fake.syncAttempts.length).toBeGreaterThanOrEqual(4), {
        timeout: 8000,
        interval: 20,
      });
      const [a0, a1, a2, a3] = fake.syncAttempts as [number, number, number, number];
      await p.disconnect();
      const attempts = fake.syncAttempts.length;

      expect(String(errors.mock.calls[0]![0])).toContain('/sync failed');
      // The gap between retries GROWS. A flat delay makes these two roughly equal.
      expect(a3 - a2).toBeGreaterThan((a1 - a0) * 2);

      // The stated throttle, graded against the CLOCK the loop actually ran on: this outage is far
      // shorter than one report interval, so it costs exactly one line however many retries it
      // took. A ceiling alone is satisfied by logging nothing, so the floor is asserted too — and
      // the line still names which failure it is, so an operator can see the ladder climbing.
      const reported = reportedFailureCounts(errors.mock.calls);
      expect(reported).toEqual([1]);
      expect(attempts).toBeGreaterThan(reported.length);
    }, 20_000);
  }
});

/**
 * CLASS: a malformed-but-PARSEABLE upstream response must not escape a fire-and-forget loop. Every
 * fault above is an HTTP status or a socket error, and both land in the loop's own try — so none of
 * them ever reaches the code that dereferences a `/sync` body. A body `res.json()` accepts but whose
 * shape the loop assumes (`null`, a scalar, a `timeline.events` that is not a list) throws from a
 * `void`-ed promise instead: under Node's default that terminates an MCP stdio bridge, and at best
 * the live path ends with no retry and nothing on stderr.
 *
 * Both fire-and-forget `/sync` drivers are graded, because they are separate loops with separate
 * error handling: `subscribe`'s, and the dedicated bounded one a blocking `fetchRecent` drives when
 * no subscription covers its topic.
 */
const FRESH = 'after-the-garbage';

/**
 * Shapes a homeserver, a proxy, or a captive portal can put on the wire that still parse as JSON,
 * each with what a PERSISTENT occurrence of it must degrade to. `reported` = the loop throws on it,
 * so it owes the operator a stderr line and a backoff; `paced` = the loop cannot tell it from an
 * empty sync, so it owes no diagnostic but must still not hot-spin. Keep the degradation on the row,
 * so that widening this table cannot add a shape nobody grades past survival.
 */
const MALFORMED: Record<string, { body: (roomId: string) => unknown; degrades: 'reported' | 'paced' }> =
  {
    'JSON null': { body: () => null, degrades: 'reported' },
    'an array': { body: () => [], degrades: 'reported' },
    'a bare string': { body: () => 'ok', degrades: 'reported' },
    'a number': { body: () => 123, degrades: 'reported' },
    'rooms: null': { body: () => ({ next_batch: 'p0', rooms: null }), degrades: 'paced' },
    'rooms.join is not a map': {
      body: () => ({ next_batch: 'p0', rooms: { join: 'x' } }),
      degrades: 'paced',
    },
    'next_batch is not a token': { body: () => ({ next_batch: 42 }), degrades: 'reported' },
    'timeline.events is not a list': {
      body: (roomId) => ({
        next_batch: 'p0',
        rooms: { join: { [roomId]: { timeline: { events: 42, limited: false } } } },
      }),
      degrades: 'reported',
    },
  };

/** Each driver arms the body, lands one well-formed message behind it, and reports what arrived. */
const DRIVERS: Record<string, (arm: () => void) => Promise<string[]>> = {
  'the subscribe loop': async (arm) => {
    const p = await connectFake({});
    const t = asTopic('resilient');
    const got: string[] = [];
    await p.subscribe(t, (m) => got.push(m.content));
    arm();
    fake.addMessage(String(t), FRESH);
    await vi
      .waitFor(() => expect(got).toContain(FRESH), { timeout: 8000, interval: 20 })
      .catch(() => undefined);
    await p.disconnect();
    return got;
  },
};

describe('a malformed but parseable /sync body never escapes a background loop', () => {
  for (const [bodyName, shape] of Object.entries(MALFORMED)) {
    for (const [driverName, drive] of Object.entries(DRIVERS)) {
      it(`${bodyName} / ${driverName}: reported and retried, never an unhandled rejection`, async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const escaped: unknown[] = [];
        const onEscape = (reason: unknown): void => void escaped.push(reason);
        process.on('unhandledRejection', onEscape);
        let got: string[] = [];
        try {
          got = await drive(() => void fake.syncBodyOverrides.push(shape.body));
          await new Promise((r) => setTimeout(r, 50)); // let a rejection reach the event loop.
        } finally {
          process.off('unhandledRejection', onEscape);
        }

        expect(escaped.map(String)).toEqual([]);
        expect(got).toContain(FRESH);
      }, 30_000);
    }
  }

  /**
   * The one throw the ladder above cannot contain: the failure REPORT itself, which runs in the
   * loop's `catch` and therefore outside every try. An MCP bridge speaks over stdio, and a closed
   * pipe makes `console.error` throw — so the loop's own error path is the last place a rejection can
   * escape from.
   */
  it('a stderr write that throws is contained too', async () => {
    const escaped: unknown[] = [];
    const onEscape = (reason: unknown): void => void escaped.push(reason);
    process.on('unhandledRejection', onEscape);
    let firstWrite = true;
    vi.spyOn(console, 'error').mockImplementation(() => {
      if (!firstWrite) return;
      firstWrite = false;
      throw new Error('EPIPE: stderr is closed');
    });
    const p = await connectFake({});
    fake.syncFailureStatus = 500;
    fake.syncFailures = Number.POSITIVE_INFINITY;

    try {
      await p.subscribe(asTopic('resilient'), () => undefined);
      await vi
        .waitFor(() => expect(fake.syncAttempts.length).toBeGreaterThanOrEqual(1), {
          timeout: 4000,
          interval: 20,
        })
        .catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off('unhandledRejection', onEscape);
      await p.disconnect();
    }

    expect(escaped.map(String)).toEqual([]);
  }, 20_000);
});

/**
 * CLASS: a malformed-upstream row must grade the DEGRADATION, not just survival. The table above
 * arms each shape ONCE and asserts only that a later well-formed message arrives — which a variant
 * that adopts the bad token, ignores it silently, or re-issues `/sync` as fast as the socket allows
 * satisfies just as well. What separates them is what a PERSISTENT occurrence costs the deployment:
 * a shape the loop throws on owes the operator a stderr line and an exponential backoff, and one it
 * cannot tell from an empty sync owes no diagnostic but must still be paced. Without this, a
 * homeserver or proxy answering one bad shape forever presents as a dead live path, no operator
 * signal, and roughly a thousandfold the request rate.
 *
 * Graded on the subscribe loop, the only `/sync` driver that reports or backs off.
 */

/** Arm a shape that RE-ARMS itself, so every `/sync` for the rest of the case answers with it. */
const armForever = (body: (roomId: string) => unknown): void => {
  const again = (roomId: string): unknown => {
    fake.syncBodyOverrides.push(again);
    return body(roomId);
  };
  fake.syncBodyOverrides.push(again);
};

/** Long enough for the paced arm to run many `/sync` rounds, short enough to keep the file quick. */
const PACING_WINDOW_MS = 600;
/**
 * Attempts a PACED loop can fit in that window. The pace floor is 25ms, so a conforming loop lands
 * near 24; an unpaced one is bounded only by the fake's 1ms round-trip and lands in the hundreds.
 */
const PACED_ATTEMPT_CEILING = 100;

describe('a malformed /sync body that never stops is reported and slowed, not hot-retried', () => {
  for (const [bodyName, shape] of Object.entries(MALFORMED)) {
    it(`${bodyName}: degrades ${shape.degrades}`, async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const p = await connectFake({});
      // Arm BEFORE subscribe, so that every incremental `/sync` of the run is the shape under test
      // and the attempt timestamps below are consecutive occurrences of it.
      armForever(shape.body);
      await p.subscribe(asTopic('doomed'), () => undefined);

      if (shape.degrades === 'paced') {
        await new Promise((r) => setTimeout(r, PACING_WINDOW_MS));
        const attempts = fake.syncAttempts.length;
        await p.disconnect();

        expect(reportedFailureCounts(errors.mock.calls)).toEqual([]);
        expect(attempts).toBeGreaterThan(1);
        expect(attempts).toBeLessThan(PACED_ATTEMPT_CEILING);
        return;
      }

      await vi.waitFor(() => expect(fake.syncAttempts.length).toBeGreaterThanOrEqual(4), {
        timeout: 8000,
        interval: 20,
      });
      const [a0, a1, a2, a3] = fake.syncAttempts as [number, number, number, number];
      await p.disconnect();

      // The same two assertions the 401/403/500/network table makes: the gap between retries GROWS…
      expect(a3 - a2).toBeGreaterThan((a1 - a0) * 2);
      // …and the operator hears about it once inside this outage, which is far shorter than one
      // report interval.
      expect(reportedFailureCounts(errors.mock.calls)).toEqual([1]);
    }, 20_000);
  }
});

/**
 * CLASS: an incremental `/sync` the loop cannot ADVANCE past. Both tables above arm an incremental
 * body for what a bad shape costs the OPERATOR — a report, a backoff, a pace — and the positioning
 * table below arms the resume token for what a bad one costs the SESSION. Neither can see the third
 * cost, because both replace the body outright and so answer with no event this fake ever minted: a
 * token that does not move re-issues the same `?since=`, which re-reads the same delta and hands the
 * same `event_id` to the handler a second time. This plugin holds no in-push dedup — the contract
 * lets push DROP (DESIGN §6) and still forbids it to REPEAT.
 *
 * The observable is one assertion for every shape: no message reaches the handler twice, and the
 * loop still recovers. Each row is armed from inside `holdSync`, so the mangled answer is the one
 * carrying the batch rather than whichever idle poll happened to be on the wire.
 */
const UNADVANCED: Record<
  string,
  (body: Record<string, unknown>, roomId: string, since: string) => unknown
> = {
  'next_batch is absent': ({ next_batch: _token, ...rest }) => rest,
  'next_batch is null': (b) => ({ ...b, next_batch: null }),
  'next_batch is a number': (b) => ({ ...b, next_batch: 0 }),
  'next_batch is the empty string': (b) => ({ ...b, next_batch: '' }),
  'next_batch repeats the token the request was made with': (b, _roomId, since) => ({
    ...b,
    next_batch: since,
  }),
};

/** The batch a mangled answer carries — both must reach the handler, and neither of them twice. */
const BATCH = ['batched-1', 'batched-2'];

describe('an incremental /sync the loop cannot resume past never delivers an event twice', () => {
  for (const [faultName, mangle] of Object.entries(UNADVANCED)) {
    it(`${faultName}: the delta it carried is delivered once, and the loop recovers`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const escaped: unknown[] = [];
      const onEscape = (reason: unknown): void => void escaped.push(reason);
      process.on('unhandledRejection', onEscape);
      const p = await connectFake({});
      const t = asTopic('unadvanced');
      const seen: { id: string; content: string }[] = [];
      await p.subscribe(t, (m) => void seen.push({ id: String(m.backendMsgId), content: m.content }));

      // Armed on the first `/sync` that has the batch to carry, so the mangled answer is the one
      // holding events: a shape armed on an idle poll breaks a token nothing was delivered under,
      // which is the one arrangement in which every row here passes for free.
      let armed = false;
      let armedAfter = 0;
      fake.holdSync = () => {
        if (armed || (fake.rooms[0]?.timeline.length ?? 0) < BATCH.length) return 0;
        armed = true;
        fake.incrementalBodyOverrides.push(mangle);
        armedAfter = fake.syncAttempts.length;
        return 0;
      };
      for (const c of BATCH) fake.addMessage(String(t), c);

      // Waiting for the batch is not enough: a token that did not move re-reads the same delta on
      // the VERY NEXT request, so the second delivery is only observable once the loop has issued
      // one. Wait for the requests, not for the messages.
      await vi
        .waitFor(() => expect(fake.syncAttempts.length).toBeGreaterThanOrEqual(armedAfter + 4), {
          timeout: 8000,
          interval: 20,
        })
        .catch(() => undefined);
      process.off('unhandledRejection', onEscape);
      await p.disconnect();

      expect(armed, 'no incremental /sync ran, so no row here armed the shape under test').toBe(true);
      expect(escaped.map(String)).toEqual([]);
      expect(
        seen.map((m) => m.id),
        'the loop resumed from a token it had already been answered on, so an event it had ' +
          'already delivered reached the handler a second time',
      ).toEqual([...new Set(seen.map((m) => m.id))]);
      expect(
        seen.map((m) => m.content),
        'the loop never recovered from a resume token it could not advance past',
      ).toEqual(BATCH);
    }, 20_000);
  }
});

/**
 * CLASS: the POSITIONING `/sync` is a phase of its own, and every field the plugin reads off it is
 * exactly as untrusted as the incremental one's. Both tables above arm incremental bodies only — yet
 * the positioning read is what decides WHERE a subscription resumes from, so a shape it mishandles
 * does not merely degrade the live path: it feeds the room's existing history into the agent session
 * as though it had just arrived. The resume TOKEN is how that happens — defaulted to `''` when
 * absent or mistyped, it asks for `?since=`, which a homeserver reads as an initial sync.
 *
 * The observable is one assertion for every shape: a message that already existed when
 * `subscribe()` was called must never arrive on the live path. Push may DROP (the tail is a subset),
 * and it may not invent.
 */
interface PositioningFault {
  mangle: (body: Record<string, unknown>, roomId: string) => unknown;
}

const BODY_FAULTS: Record<string, PositioningFault['mangle']> = {
  'next_batch is absent': ({ next_batch: _token, ...rest }) => rest,
  'next_batch is null': (b) => ({ ...b, next_batch: null }),
  'next_batch is a number': (b) => ({ ...b, next_batch: 0 }),
  'next_batch is the empty string': (b) => ({ ...b, next_batch: '' }),
  'the body is JSON null': () => null,
  'the body is an array': () => [],
  'the body is a scalar': () => 'ok',
  'the room is missing from rooms.join': (b) => ({ ...b, rooms: { join: {} } }),
  'the room carries no timeline': (b, roomId) => ({ ...b, rooms: { join: { [roomId]: {} } } }),
};

/**
 * The boundary read is a PREDICATE, so it owes a cell per input it can branch on rather than a row
 * per field somebody thought of — a clause reading a field no row varies is born untested and stays
 * that way. Generated as the product of the two fields it reads, sweeping `limited` against every
 * `events` shape and not only the one it discriminates today, because which pair a clause separates
 * is the predicate's business and not this table's.
 */
const EVENTS_SHAPES: Record<string, (tip: unknown[]) => Record<string, unknown>> = {
  'events absent': () => ({}),
  'events is not a list': () => ({ events: 42 }),
  'events is empty': () => ({ events: [] }),
  'events holds the tip the position was read at': (tip) => ({ events: tip }),
  'events holds an event carrying no id': () => ({
    events: [{ type: 'm.room.message', content: { body: 'x' } }],
  }),
};

const LIMITED_SHAPES: Record<string, Record<string, unknown>> = {
  'limited true': { limited: true },
  'limited false': { limited: false },
  'limited absent': {},
};

const tipOf = (body: Record<string, unknown>, roomId: string): unknown[] => {
  const join = (body.rooms as { join?: Record<string, { timeline?: { events?: unknown[] } }> }).join;
  return join?.[roomId]?.timeline?.events ?? [];
};

const TIMELINE_FAULTS: Record<string, PositioningFault> = Object.fromEntries(
  Object.entries(EVENTS_SHAPES).flatMap(([eventsName, shape]) =>
    Object.entries(LIMITED_SHAPES).map(([limitedName, limited]): [string, PositioningFault] => [
      `${eventsName} / ${limitedName}`,
      {
        mangle: (body, roomId) => ({
          ...body,
          rooms: { join: { [roomId]: { timeline: { ...shape(tipOf(body, roomId)), ...limited } } } },
        }),
      },
    ]),
  ),
);

const POSITIONING_FAULTS: Record<string, PositioningFault> = {
  ...Object.fromEntries(
    Object.entries(BODY_FAULTS).map(([name, mangle]): [string, PositioningFault] => [
      name,
      { mangle },
    ]),
  ),
  ...TIMELINE_FAULTS,
};

/** Messages already in the room when `subscribe()` is called — none may arrive as a live event. */
const PRE_SUBSCRIPTION = ['pre1', 'pre2', 'pre3'];
/** Messages landing after it, larger than the `limited` cap the rows arm, so recovery is exercised. */
const POST_SUBSCRIPTION = ['live1', 'live2', 'live3'];

/** Arm a positioning shape that RE-ARMS itself: a parked read re-positions more than once. */
const armPositioningForever = (
  mangle: (body: Record<string, unknown>, roomId: string) => unknown,
): void => {
  const again = (body: Record<string, unknown>, roomId: string): unknown => {
    fake.positioningBodyOverrides.push(again);
    return mangle(body, roomId);
  };
  fake.positioningBodyOverrides.push(again);
};

/**
 * The pagination-token grammar {@link FakeSynapse} mints. A `since` outside it is one no homeserver
 * handed the plugin — `''` and the string `'undefined'` are the two a defaulted token produces, and
 * the first of them is read as a request for an initial sync.
 */
const MINTED_TOKEN = /^p\d+$/;

const sinceParamsSince = (from: number): (string | null)[] =>
  fake.requestUrls
    .slice(from)
    .filter((u) => u.pathname.endsWith('/v3/sync'))
    .map((u) => u.searchParams.get('since'));

describe('a positioning /sync the plugin cannot resume from never replays the room as live events', () => {
  for (const [faultName, fault] of Object.entries(POSITIONING_FAULTS)) {
    const { mangle } = fault;
    it(`${faultName} / the subscribe loop: nothing that predates subscribe() is delivered`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const escaped: unknown[] = [];
      const onEscape = (reason: unknown): void => void escaped.push(reason);
      process.on('unhandledRejection', onEscape);
      const p = await connectFake({});
      const t = asTopic('positioned');
      for (const c of PRE_SUBSCRIPTION) await p.post(t, asHandle('writer'), c);
      const from = fake.requestUrls.length;

      const seen: string[] = [];
      armPositioningForever(mangle);
      const resolved = await p.subscribe(t, (m) => void seen.push(m.content)).then(
        () => true,
        () => false,
      );
      // Truncate the burst, so the rows cover a `limited` sync as well as a whole one: a shape the
      // positioning read mishandles must not turn a truncated timeline into a walk back into
      // history either.
      fake.syncCap = 1;
      for (const c of POST_SUBSCRIPTION) fake.addMessage(String(t), c);
      await new Promise((r) => setTimeout(r, 400));
      process.off('unhandledRejection', onEscape);
      await p.disconnect();

      expect(
        seen.filter((c) => PRE_SUBSCRIPTION.includes(c)),
        'history that was already in the room arrived as a live <channel> event',
      ).toEqual([]);
      expect(escaped.map(String)).toEqual([]);
      for (const since of sinceParamsSince(from)) {
        if (since !== null) expect(since).toMatch(MINTED_TOKEN);
      }
      if (resolved) {
        expect(seen, 'subscribe() resolved, so what landed after it still owes delivery').toContain(
          POST_SUBSCRIPTION.at(-1),
        );
        expect(
          fake.limitedEmitted,
          'the burst was never truncated, so no row here graded a `limited` sync at all',
        ).toBeGreaterThan(0);
      }
    }, 20_000);
  }
});

/**
 * CLASS: a 200 that has STOPPED naming the resource the loop reads. Every fault above is an HTTP
 * status, a socket error, or a body shape — all of them things the loop can see. Losing membership
 * of the room is none of those: `/sync` keeps answering 200, the room simply moves out of
 * `rooms.join`, the timeline read comes back `undefined`, and a loop grading only what it CAN read
 * calls that a healthy empty sync — resetting its failure counter, logging nothing, and long-polling
 * a dead topic at full rate forever. Only the READ path 403s on a kick, so the loud half of the
 * plugin is the one that still works and the live half is the mute one.
 *
 * Two of the rows must NOT read as a loss, because the naive spelling of this guard — "the room is
 * absent from `rooms.join`" — is satisfied by every idle poll, and a delta can span a removal and a
 * return. A guard graded only on the shapes it must catch is one that may catch everything.
 */
interface MembershipRow {
  arm: () => void;
  /** `reported` = the operator gets a line and the retries slow down; `silent` = an ordinary sync. */
  degrades: 'reported' | 'silent';
  /** What the stderr line must name, beyond the topic and the room. */
  names?: RegExp;
  /** Whether a message landing after the shape is armed still reaches the handler. */
  delivers: boolean;
}

const MEMBERSHIP_LOSS: Record<string, MembershipRow> = {
  'kicked — the room moves to rooms.leave': {
    arm: () => void (fake.membership = 'leave'),
    degrades: 'reported',
    names: /membership: leave/,
    delivers: false,
  },
  'banned — the same, with an m.room.member of ban': {
    arm: () => void (fake.membership = 'ban'),
    degrades: 'reported',
    names: /membership: ban/,
    delivers: false,
  },
  'removed and re-joined inside one delta': {
    arm: () => void (fake.membership = 'rejoined'),
    degrades: 'silent',
    delivers: true,
  },
  'the room is merely absent from rooms.join, as an idle poll leaves it': {
    arm: () => armForever(() => ({ next_batch: 'p0', rooms: { join: {} } })),
    degrades: 'silent',
    delivers: false,
  },
};

describe('a /sync that stopped carrying the subscribed room is reported, not read as idle', () => {
  for (const [name, row] of Object.entries(MEMBERSHIP_LOSS)) {
    it(`${name}: degrades ${row.degrades}`, async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const p = await connectFake({});
      const t = asTopic('kicked-out');
      const got: string[] = [];
      await p.subscribe(t, (m) => void got.push(m.content));
      const roomId = fake.rooms[0]!.roomId;
      const from = fake.syncAttempts.length;
      row.arm();
      fake.addMessage(String(t), FRESH);

      if (row.degrades === 'silent') {
        await new Promise((r) => setTimeout(r, PACING_WINDOW_MS));
        const attempts = fake.syncAttempts.length - from;
        await p.disconnect();

        expect(reportedFailureCounts(errors.mock.calls)).toEqual([]);
        expect(attempts).toBeGreaterThan(1);
        expect(attempts).toBeLessThan(PACED_ATTEMPT_CEILING);
        expect(got.includes(FRESH)).toBe(row.delivers);
        return;
      }

      await vi.waitFor(() => expect(fake.syncAttempts.length - from).toBeGreaterThanOrEqual(4), {
        timeout: 8000,
        interval: 20,
      });
      const [a0, a1, a2, a3] = fake.syncAttempts.slice(from) as [number, number, number, number];
      await p.disconnect();

      const said = errors.mock.calls.map((c) => String(c[0]));
      expect(
        said.filter((line) => line.includes(String(t)) && line.includes(roomId)),
        'a removal from the room reached the operator naming neither the topic nor the room',
      ).not.toEqual([]);
      expect(said.join('\n')).toMatch(row.names!);
      // The same backoff the 401/500/network rows get: the gap between retries GROWS.
      expect(a3 - a2).toBeGreaterThan((a1 - a0) * 2);
      expect(reportedFailureCounts(errors.mock.calls)).toEqual([1]);
      expect(got).toEqual([]);
    }, 20_000);
  }
});

/**
 * CLASS: an operator's only view of a dead live path is stderr, so the report point has to hold
 * against BOTH failure shapes at once — a path that never recovers, and one that recovers half the
 * time. A throttle keyed on the failure COUNT holds against neither.
 *
 * Graded on the reporter with an injected clock rather than through the loop: the interval is a
 * minute, and the property is about hours of it. What the loop contributes — that this is the
 * function it calls, once per failure, with the running count — is graded by the cases above.
 */
describe('the /sync report point is bounded by the clock, not by the failure count', () => {
  /** A run of `ticks` failures, `everyMs` apart, whose Nth attempt succeeds iff `recovers(n)`. */
  const run = (opts: { ticks: number; everyMs: number; recovers?: (n: number) => boolean }): number[] => {
    let clock = 0;
    const at: number[] = [];
    const report = syncFailureReporter(() => clock);
    vi.spyOn(console, 'error').mockImplementation(() => {
      at.push(clock);
    });
    let consecutive = 0;
    for (let n = 0; n < opts.ticks; n++) {
      clock += opts.everyMs;
      if (opts.recovers?.(n) === true) {
        consecutive = 0;
        continue;
      }
      consecutive += 1;
      report(asTopic('doomed'), consecutive, new Error('boom'));
    }
    return at;
  };

  it('a path that is permanently dead keeps saying so, at a bounded interval', () => {
    // Twelve hours of a homeserver that never answers, retried at the ladder's ceiling.
    const said = run({ ticks: (12 * 3_600_000) / 30_000, everyMs: 30_000 });
    expect(said.length).toBeGreaterThan(0);
    const gaps = said.slice(1).map((t, i) => t - said[i]!);
    expect(
      Math.max(...gaps),
      'the interval between report points GREW: a throttle on powers of two of the failure count ' +
        'does that forever, because the retry delay it multiplies is capped — so a path dead for ' +
        'days reports at hour 34 and then says nothing for another day and a half',
    ).toBeLessThanOrEqual(SYNC_DIAG_INTERVAL_MS + 30_000);
    expect(said.length).toBeGreaterThanOrEqual((11 * 3_600_000) / SYNC_DIAG_INTERVAL_MS);
  });

  it('a server that answers every other request does not flood', () => {
    // An hour of 1-in-2 at the ladder's FIRST rung, which is where a count that resets on any
    // success pins it: 200ms apart, so nothing here is throttled by the backoff at all.
    const said = run({ ticks: 3_600_000 / 200, everyMs: 200, recovers: (n) => n % 2 === 0 });
    expect(
      said.length,
      'an intermittently failing homeserver flooded stderr: `consecutiveFailures` resets on ANY ' +
        'success, so a count-keyed report point sits at rung one forever and says so on every ' +
        'other request',
    ).toBeLessThanOrEqual(3_600_000 / SYNC_DIAG_INTERVAL_MS + 1);
    expect(said.length).toBeGreaterThan(0);
  });
});
