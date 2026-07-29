import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectFake, FakeSynapse } from './fake-synapse.js';

/**
 * CLASS: a parked long-poll must be woken by whatever actually observes ITS message, its
 * reconciling re-query must be ordered strictly AFTER that wake source is positioned, and its
 * promptness must not depend on a background loop it does not own staying healthy. In production
 * `catchup.block_max_ms` defaults to 60s, so any of the three turns a landed message into a minute
 * of silence.
 *
 * The fake collapses every topic onto one room, so each cell here is also the shared-room case:
 * the blocked topic and the subscribed topic sit in the SAME room whenever they differ.
 *
 * Two regimes, deliberately kept apart. The wake-source and phase tables run with the long-poll
 * slice set LONGER than the whole budget, so nothing but the wake source under test can end the
 * wait — the plugin's bounded safety re-query would otherwise rescue every one of them and they
 * would grade nothing. The loop-health table is the mirror image: the slice is short, and the
 * safety re-query is the only thing left.
 */

const BLOCK_MS = 3000;
/** A wake that arrives on the real wake source lands in tens of ms; the bug spends the whole budget. */
const PROMPT_MS = 1500;
/** A long-poll slice past `BLOCK_MS`: no safety re-query can fire inside the budget. */
const NO_SAFETY_NET_MS = 8000;
const WRITER = asHandle('writer');

let fake: FakeSynapse;
const timers: ReturnType<typeof setTimeout>[] = [];
beforeEach(() => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  // Keep this drain, so that a timer armed by one case cannot post into the next case's fake.
  for (const t of timers.splice(0)) clearTimeout(t);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SUBSCRIBE_KINDS = [
  'no subscribe',
  'subscribed to the blocked topic',
  'subscribed to another topic',
] as const;
type SubscribeKind = (typeof SUBSCRIBE_KINDS)[number];

const BLOCKED = asTopic('blocked-topic');
const OTHER = asTopic('other-topic');
const subscribedTopic = (kind: SubscribeKind): Topic =>
  kind === 'subscribed to another topic' ? OTHER : BLOCKED;

/** WHICH participant's `timeout=0` positioning sync is stalled while the message lands. */
const STALLS = ['nobody', 'the subscribe loop', 'the blocking fetch', 'both'] as const;

describe('blocking fetchRecent wakes promptly whatever else is subscribed', () => {
  for (const shared of [true, false]) {
    for (const kind of SUBSCRIBE_KINDS) {
      for (const stall of STALLS) {
        const subscribed = kind !== 'no subscribe';
        const stallsSubscribe = stall === 'the subscribe loop' || stall === 'both';
        const stallsBlocking = stall === 'the blocking fetch' || stall === 'both';
        if (!subscribed && stallsSubscribe) continue;

        it(`${shared ? 'shared_room' : 'per-topic'} / ${kind} / positioning stalled: ${stall}`, async () => {
          const p = await connectFake({ shared, syncTimeoutMs: NO_SAFETY_NET_MS });
          await p.post(BLOCKED, WRITER, 'old');
          const tail = (await p.fetchRecent({ topic: BLOCKED, limit: 10 })).nextCursor;

          // The subscribe loop positions first (it is started first), so the blocking fetch's own
          // dedicated positioning sync — when it opens one — is the ordinal right after it.
          const subOrdinal = 1;
          const blockOrdinal = subscribed ? 2 : 1;
          const targets = [
            ...(stallsSubscribe ? [subOrdinal] : []),
            ...(stallsBlocking ? [blockOrdinal] : []),
          ];
          fake.stallPositioning = (n) => targets.includes(n);
          fake.stallPositioningMs = 600;

          // A blocking fetch opens its OWN sync unless a subscribe loop on its exact (room, topic)
          // has already positioned — a stalled subscribe loop has not.
          const hooksLiveLoop = kind === 'subscribed to the blocked topic' && !stallsSubscribe;
          const expectStalled = targets.filter((n) => n !== blockOrdinal || !hooksLiveLoop);

          let subscribing: Promise<void> | undefined;
          if (subscribed) {
            subscribing = p.subscribe(subscribedTopic(kind), () => undefined);
            if (!stallsSubscribe) await subscribing;
          }

          const started = Date.now();
          const pending = p.fetchRecent({ topic: BLOCKED, since: tail, blockMs: BLOCK_MS });
          timers.push(setTimeout(() => void p.post(BLOCKED, WRITER, 'fresh'), 150));

          const woke = await pending;
          const elapsed = Date.now() - started;
          await subscribing;

          expect(woke.messages.map((m) => m.content)).toContain('fresh');
          expect(elapsed).toBeLessThan(PROMPT_MS);
          // A row that stalled nobody fails here instead of quietly grading a different participant.
          expect(fake.stalledPositioning).toEqual(expectStalled);
          await p.disconnect();
        });
      }
    }
  }
});

/**
 * WHEN the message lands, driven off the fake's own request hooks so each phase is exact rather
 * than raced against a wall-clock timer. `applies` names the wake sources for which the phase is a
 * real window: a fetch that hooks a live subscribe loop opens no positioning sync of its own.
 */
const PHASES: Record<
  string,
  {
    applies: (kind: SubscribeKind) => boolean;
    /** Arms the phase and returns the proof that it really fired. */
    arm: (land: () => void) => () => boolean;
  }
> = {
  'before the fetch is even called': {
    applies: () => true,
    arm: (land) => {
      land();
      return () => true;
    },
  },
  "inside the blocking fetch's own positioning sync": {
    applies: (kind) => kind !== 'subscribed to the blocked topic',
    arm: (land) => {
      // The subscribe loop, when there is one, has already positioned; the blocking fetch is next.
      const target = fake.positioningSyncs + 1;
      fake.stallPositioning = (n) => n === target;
      fake.stallPositioningMs = 400;
      fake.duringPositioningStall = land;
      return () => fake.stalledPositioning.includes(target);
    },
  },
  'inside the pre-park recheck, after that read has already snapshotted its empty result': {
    applies: () => true,
    arm: (land) => {
      // The recheck is the SECOND `/context` of the call (first: the pre-block catch-up query;
      // third: the post-park re-query). Land the message on the recheck's final, empty forward
      // page — the read is then provably past it, and only a registered waiter can still be woken.
      let contexts = 0;
      let armed = false;
      let fired = false;
      fake.onRequest = (_m, path) => {
        if (path.includes('/context/') && ++contexts === 2) armed = true;
      };
      fake.holdMessages = (url, body) => {
        if (!armed || url.searchParams.get('dir') !== 'f' || body.chunk.length > 0) return 0;
        armed = false;
        fired = true;
        land();
        return 400;
      };
      return () => fired;
    },
  },
};

describe('a message is found whatever phase of the blocking fetch it lands in', () => {
  for (const [phaseName, phase] of Object.entries(PHASES)) {
    for (const kind of SUBSCRIBE_KINDS) {
      if (!phase.applies(kind)) continue;

      it(`${kind} / the message lands ${phaseName}`, async () => {
        const p = await connectFake({ shared: true, syncTimeoutMs: NO_SAFETY_NET_MS });
        await p.post(BLOCKED, WRITER, 'old');
        const tail = (await p.fetchRecent({ topic: BLOCKED, limit: 10 })).nextCursor;
        if (kind !== 'no subscribe') await p.subscribe(subscribedTopic(kind), () => undefined);

        const fired = phase.arm(() => void fake.addMessage(String(BLOCKED), 'fresh'));

        const started = Date.now();
        const woke = await p.fetchRecent({ topic: BLOCKED, since: tail, blockMs: BLOCK_MS });
        const elapsed = Date.now() - started;

        expect(woke.messages.map((m) => m.content)).toContain('fresh');
        expect(elapsed).toBeLessThan(PROMPT_MS);
        // A phase that never actually fired would otherwise grade as a pass on some other window.
        expect(fired()).toBe(true);
        await p.disconnect();
      });
    }
  }
});

/**
 * CLASS: every path that hands a message to the subscribe handler must also wake the waiters parked
 * on that room. A delivery path that forgets leaves a parked `fetchRecent` asleep for its whole
 * budget even though the live loop already saw the message.
 */
const DELIVERY_PATHS = {
  'a normal incremental sync': { syncCap: 100, foreignAfter: 0 },
  'a `limited` burst recovered via prev_batch': { syncCap: 2, foreignAfter: 0 },
  'a `limited` burst whose belonging event is in the truncated tail': { syncCap: 2, foreignAfter: 2 },
} as const;

describe('a live subscribe delivery wakes the waiter parked on its room', () => {
  for (const [name, shape] of Object.entries(DELIVERY_PATHS)) {
    it(`${name}: the parked fetchRecent returns as promptly as the handler saw it`, async () => {
      const p = await connectFake({ shared: true, syncTimeoutMs: NO_SAFETY_NET_MS });
      const blocked = asTopic('topic-A');
      await p.post(blocked, WRITER, 'old');
      const tail = (await p.fetchRecent({ topic: blocked, limit: 10 })).nextCursor;

      const delivered: number[] = [];
      await p.subscribe(blocked, () => delivered.push(Date.now()));
      fake.syncCap = shape.syncCap;

      const started = Date.now();
      const pending = p.fetchRecent({ topic: blocked, since: tail, blockMs: BLOCK_MS });
      timers.push(
        setTimeout(() => {
          fake.addMessage(String(blocked), 'fresh');
          for (let i = 0; i < shape.foreignAfter; i++) fake.addMessage('other-topic', `f${i}`);
        }, 150),
      );

      const woke = await pending;
      const elapsed = Date.now() - started;

      expect(woke.messages.map((m) => m.content)).toContain('fresh');
      expect(delivered).toHaveLength(1);
      expect(elapsed).toBeLessThan(PROMPT_MS);
      await p.disconnect();
    });
  }
});

/**
 * CLASS: the plugin's promptness must not depend on a wake source it does not own. Every cell below
 * runs with a `/sync` wake source that has stopped observing — a subscribe loop in exponential
 * retry backoff (up to 30s), one that will never recover, one alive but parked mid-backfill, or a
 * dedicated `/sync` whose own poll died — and the parked `fetchRecent` must still surface the
 * message from its own bounded re-query.
 */
const WAKE_SOURCE_HEALTH: Record<
  string,
  {
    kinds?: readonly SubscribeKind[];
    arm: () => void;
    land: (topic: Topic) => void;
  }
> = {
  'in exponential retry backoff': {
    arm: () => {
      fake.syncFailures = 5;
    },
    land: (topic) => void fake.addMessage(String(topic), 'fresh'),
  },
  'failing permanently (revoked token / kicked)': {
    arm: () => {
      fake.syncFailures = Number.POSITIVE_INFINITY;
    },
    land: (topic) => void fake.addMessage(String(topic), 'fresh'),
  },
  'alive but stalled mid-backfill': {
    kinds: ['subscribed to the blocked topic'],
    arm: () => {
      fake.syncCap = 1;
      fake.holdMessages = (url) =>
        url.searchParams.get('dir') === 'b' && url.searchParams.has('from') ? 2000 : 0;
    },
    // A burst larger than the cap in ONE tick, so the loop is provably driven into the backfill it
    // is then held inside, with `fresh` in the truncated (backfilled) part.
    land: (topic) => {
      fake.addMessage(String(topic), 'fresh');
      fake.addMessage('other-topic', 'x1');
      fake.addMessage('other-topic', 'x2');
    },
  },
};

describe('a blocking fetchRecent stays prompt when its wake source stops observing', () => {
  for (const [healthName, health] of Object.entries(WAKE_SOURCE_HEALTH)) {
    for (const kind of health.kinds ?? SUBSCRIBE_KINDS) {
      it(`${kind} / the /sync wake source is ${healthName}`, async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const p = await connectFake({ shared: true });
        await p.post(BLOCKED, WRITER, 'old');
        const tail = (await p.fetchRecent({ topic: BLOCKED, limit: 10 })).nextCursor;
        if (kind !== 'no subscribe') await p.subscribe(subscribedTopic(kind), () => undefined);

        // Arm AFTER positioning, so the loop is registered as this topic's live wake source and
        // only then goes deaf — the exact state in which the waiter has nobody left to wake it.
        health.arm();

        const started = Date.now();
        const pending = p.fetchRecent({ topic: BLOCKED, since: tail, blockMs: BLOCK_MS });
        timers.push(setTimeout(() => health.land(BLOCKED), 150));

        const woke = await pending;
        const elapsed = Date.now() - started;

        expect(woke.messages.map((m) => m.content)).toContain('fresh');
        expect(elapsed).toBeLessThan(PROMPT_MS);
        await p.disconnect();
      });
    }
  }
});
