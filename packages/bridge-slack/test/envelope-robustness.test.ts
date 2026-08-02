/**
 * CLASS: every field of an inbound Socket Mode envelope is vendor- or attacker-controlled, and the
 * plugin owes Slack an ack for ALL of them — including the ones it deliberately drops.
 *
 * Two failure shapes hide behind the happy path and are covered here from ONE table:
 *
 * (1) An unguarded dereference of an inbound field (`event.ts`) throws inside a `ws.on('message')`
 *     callback. There is no caller to propagate to, so it becomes an `uncaughtException` and takes
 *     the whole bridge process down. The waiter loop that a blocking `fetchRecent` parks runs
 *     BEFORE any route dispatch and outside its try/catch, so the arm with no route registered is
 *     the dangerous one — and the one nothing else in the suite drives.
 *
 * (2) Slack redelivers an unacked envelope and eventually drops the connection, so an ack that only
 *     lands for envelopes reaching a registered handler turns ordinary `channel_join` traffic into
 *     a redeliver/disconnect loop. The ack assertion therefore runs over dropped envelopes, not
 *     just surfaced ones.
 */
import {
  asCursor,
  asHandle,
  asTopic,
  type Message,
  type MessageHandler,
  type Topic,
} from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';
import { startSlack } from './harness.js';

const ROUTED = 'C0ROUTED';
const UNROUTED = 'C0UNROUTED';

/** Envelope bodies the plugin must ack and must not die on. None of these may surface a message. */
const DROPPED: Array<{ name: string; body: (fake: FakeSlack) => Record<string, unknown> }> = [
  { name: 'events_api with no payload', body: () => ({ type: 'events_api' }) },
  { name: 'events_api with a null payload', body: () => ({ type: 'events_api', payload: null }) },
  {
    name: 'events_api with no event',
    body: () => ({ type: 'events_api', payload: { not_event: 1 } }),
  },
  {
    name: 'event with no ts',
    body: () => ({ type: 'events_api', payload: { event: { type: 'message', channel: ROUTED, text: 'x' } } }),
  },
  {
    name: 'event with a null ts',
    body: () => ({ type: 'events_api', payload: { event: { type: 'message', channel: ROUTED, ts: null } } }),
  },
  {
    name: 'event with a numeric ts',
    body: () => ({ type: 'events_api', payload: { event: { type: 'message', channel: ROUTED, ts: 42 } } }),
  },
  {
    name: 'event with an empty ts',
    body: () => ({ type: 'events_api', payload: { event: { type: 'message', channel: ROUTED, ts: '' } } }),
  },
  {
    name: 'event with a non-numeric ts',
    body: () => ({ type: 'events_api', payload: { event: { type: 'message', channel: ROUTED, ts: 'abc' } } }),
  },
  {
    name: 'event with a three-part ts',
    body: () => ({ type: 'events_api', payload: { event: { type: 'message', channel: ROUTED, ts: '1.2.3' } } }),
  },
  {
    name: 'event with a numeric channel',
    body: (fake) => ({ type: 'events_api', payload: { event: { type: 'message', channel: 42, ts: fake.mintTs() } } }),
  },
  {
    name: 'event with no channel',
    body: (fake) => ({ type: 'events_api', payload: { event: { type: 'message', ts: fake.mintTs() } } }),
  },
  {
    name: 'event with a numeric subtype',
    body: (fake) => ({
      type: 'events_api',
      payload: { event: { type: 'message', channel: ROUTED, ts: fake.mintTs(), subtype: 123 } },
    }),
  },
  {
    name: 'event with a non-message type',
    body: (fake) => ({
      type: 'events_api',
      payload: { event: { type: 'reaction_added', channel: ROUTED, ts: fake.mintTs() } },
    }),
  },
  {
    name: 'a dropped subtype on a routed channel',
    body: (fake) => ({
      type: 'events_api',
      payload: {
        event: { type: 'message', channel: ROUTED, ts: fake.mintTs(), text: 'joined', subtype: 'channel_join' },
      },
    }),
  },
  {
    name: 'a plain message on an UNROUTED channel',
    body: (fake) => ({
      type: 'events_api',
      payload: { event: { type: 'message', channel: UNROUTED, ts: fake.mintTs(), text: 'elsewhere' } },
    }),
  },
  { name: 'an unknown envelope type', body: () => ({ type: 'slash_commands', payload: {} }) },
  { name: 'an envelope with no type at all', body: () => ({ payload: { event: null } }) },
];

interface Harness {
  fake: FakeSlack;
  plugin: SlackPlugin;
  topic: Topic;
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const started = await startSlack({ channels: [ROUTED, UNROUTED] });
  return { ...started, topic: asTopic(ROUTED) };
}

/** Watch for the crash shape a throw inside `ws.on('message')` produces. */
function watchForCrashes(): { crashes: unknown[]; stop: () => void } {
  const crashes: unknown[] = [];
  const onCrash = (e: unknown): void => {
    crashes.push(e);
  };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  return {
    crashes,
    stop: () => {
      process.off('uncaughtException', onCrash);
      process.off('unhandledRejection', onCrash);
    },
  };
}

describe('slack socket mode: untrusted envelopes', () => {
  it('with a route registered: every dropped envelope is acked, nothing surfaces, nothing crashes', async () => {
    const h = await harness();
    const watch = watchForCrashes();
    try {
      const live: Message[] = [];
      await h.plugin.subscribe(h.topic, (m) => live.push(m));

      const ids = new Map<string, string>();
      for (const row of DROPPED) ids.set(row.name, h.fake.pushEnvelope(row.body(h.fake)));

      // A well-formed push AFTER the whole table: proves the socket is still serving.
      await h.plugin.post(h.topic, asHandle('writer'), 'still alive');
      await vi.waitFor(() => expect(live.map((m) => m.content)).toEqual(['still alive']), {
        timeout: 3000,
        interval: 10,
      });
      await vi.waitFor(
        () => {
          for (const [name, id] of ids) expect(h.fake.acked, `unacked: ${name}`).toContain(id);
        },
        { timeout: 3000, interval: 10 },
      );
      expect(live.map((m) => m.content)).toEqual(['still alive']);
      expect(watch.crashes).toEqual([]);
    } finally {
      watch.stop();
      await h.cleanup();
    }
  });

  it('with a blocking fetch parked and NO route: the same table neither crashes nor loses the wake', async () => {
    const h = await harness();
    const watch = watchForCrashes();
    try {
      const parked = h.plugin.fetchRecent({ topic: h.topic, since: asCursor('0'), blockMs: 4000 });
      // Let the waiter arm (handshake + gap-closing re-query) before the table lands.
      await new Promise((r) => setTimeout(r, 250));

      const ids = new Map<string, string>();
      for (const row of DROPPED) ids.set(row.name, h.fake.pushEnvelope(row.body(h.fake)));

      const [created] = h.fake.seed(h.topic, [{ text: 'wakes it' }]);
      h.fake.pushEvent(h.topic, { ts: created!.ts, text: 'wakes it', user: 'U0PARLEY' });

      const result = await parked;
      expect(result.messages.map((m) => m.content)).toEqual(['wakes it']);
      for (const [name, id] of ids) expect(h.fake.acked, `unacked: ${name}`).toContain(id);
      expect(watch.crashes).toEqual([]);
    } finally {
      watch.stop();
      await h.cleanup();
    }
  });

  it('a throwing handler still gets its envelope acked', async () => {
    const h = await harness();
    try {
      await h.plugin.subscribe(h.topic, () => {
        throw new Error('handler exploded');
      });
      await h.plugin.post(h.topic, asHandle('writer'), 'boom');
      await vi.waitFor(
        () => {
          expect(h.fake.pushed.size).toBeGreaterThan(0);
          for (const id of h.fake.pushed) expect(h.fake.acked).toContain(id);
        },
        { timeout: 3000, interval: 10 },
      );
    } finally {
      await h.cleanup();
    }
  });

  it('a `disconnect` envelope rotates the socket and live delivery resumes', async () => {
    const h = await harness();
    try {
      const live: Message[] = [];
      await h.plugin.subscribe(h.topic, (m) => live.push(m));
      // Real Socket Mode sends `disconnect` with NO `envelope_id` — Slack asks for an ack only on
      // `events_api`/`slash_commands`/`interactive` — so there is nothing here to ack, and the
      // observable is the rotation itself.
      const dialsBefore = h.fake.connectionsOpened;
      h.fake.pushUnackedEnvelope({ type: 'disconnect', reason: 'refresh_requested' });

      // A live-socket count of 1 is also true of the socket that has not closed YET, so wait for the
      // replacement handshake itself before asserting delivery resumed on it.
      await vi.waitFor(
        () => {
          expect(h.fake.connectionsOpened).toBeGreaterThan(dialsBefore);
          expect(h.fake.liveSockets).toBe(1);
        },
        { timeout: 4000, interval: 10 },
      );
      await h.plugin.post(h.topic, asHandle('writer'), 'after rotate');
      await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('after rotate'), {
        timeout: 4000,
        interval: 10,
      });
    } finally {
      await h.cleanup();
    }
  });
});

/**
 * An ack is exactly `{envelope_id}` and nothing else; every envelope the fake PUSHES carries a `type`
 * as well. Reading the shape rather than the direction keeps this usable on a prototype shared by
 * both ends of the connection.
 */
function ackIdOf(data: unknown): string | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    if (keys.length === 1 && keys[0] === 'envelope_id' && typeof parsed.envelope_id === 'string') {
      return parsed.envelope_id;
    }
  } catch {
    /* not JSON — not an ack */
  }
  return undefined;
}

/**
 * The order in which the plugin CALLED `send`, interleaved with markers its handler pushes.
 *
 * Arrival order at the fake cannot express this contract at all: the fake shares this process's event
 * loop, so a synchronous handler always finishes before any ack can be read off the socket — which is
 * why the only surviving guard on ack-first was an artefact of the fixture minting an `envelope_id`
 * for an envelope Slack never asks to have acked. The call order is the contract, and it is
 * observable only here.
 */
function journalSends(journal: string[]): () => void {
  const real = WebSocket.prototype.send;
  const patched = function (this: WebSocket, data: unknown, ...rest: unknown[]): unknown {
    const ack = ackIdOf(data);
    if (ack !== undefined) journal.push(`ack:${ack}`);
    return (real as unknown as (...a: unknown[]) => unknown).call(this, data, ...rest);
  };
  WebSocket.prototype.send = patched as unknown as typeof WebSocket.prototype.send;
  return () => {
    WebSocket.prototype.send = real;
  };
}

/**
 * How the handler behaves once it is reached. Slack redelivers an unacked envelope and eventually
 * drops the connection, so NO handler behaviour may be observable before the ack is on the wire —
 * a handler that never returns is the limiting case, and the blocking row is its testable form.
 */
const HANDLER_BEHAVIOURS: Array<{ name: string; run: () => void }> = [
  { name: 'returns normally', run: () => undefined },
  {
    name: 'throws',
    run: () => {
      throw new Error('handler exploded');
    },
  },
  {
    name: 'throws a non-Error',
    run: () => {
      throw 'handler exploded';
    },
  },
  {
    name: 'blocks the event loop',
    run: () => {
      const until = Date.now() + 150;
      while (Date.now() < until) {
        /* deliberately starving the loop the ack would otherwise be flushed on */
      }
    },
  },
];

describe('slack socket mode: the ack precedes any handler processing', () => {
  for (const behaviour of HANDLER_BEHAVIOURS) {
    it(`a handler that ${behaviour.name} is never reached before its envelope is acked`, async () => {
      const h = await harness();
      const journal: string[] = [];
      // Patch AFTER the handshake, so the journal holds only the envelope under test.
      await h.plugin.subscribe(h.topic, () => {
        journal.push('handler');
        behaviour.run();
      });
      const stop = journalSends(journal);
      try {
        const before = new Set(h.fake.pushed);
        await h.plugin.post(h.topic, asHandle('writer'), 'ordered');
        await vi.waitFor(() => expect(journal).toContain('handler'), { timeout: 3000, interval: 5 });

        const [id] = [...h.fake.pushed].filter((p) => !before.has(p));
        expect(id, 'exactly one new envelope').toBeDefined();
        expect(journal).toEqual([`ack:${id!}`, 'handler']);
        await vi.waitFor(() => expect(h.fake.acked).toContain(id!), { timeout: 3000, interval: 5 });
      } finally {
        stop();
        await h.cleanup();
      }
    });
  }
});

/**
 * CLASS: a subscribe handler's FAILURE, in every shape the seam's `(msg: Message) => void` admits.
 *
 * That return type does not forbid an `async` handler, and core is free to pass one, so a `try {
 * handler(m) } catch {}` around the call sees a synchronous throw and nothing else: a rejected
 * promise walks straight past it and, on Node's default `--unhandled-rejections=throw`, ends the
 * bridge process — a live-push backend killed by whatever the agent-side handler did with one
 * message. The containment must therefore be graded from the FAILURE SHAPE, not from whether the
 * plugin happens to call the handler synchronously today.
 *
 * The `never settles` row is the other half, and the reason the rejection arm must not be awaited:
 * awaiting it would serialise delivery behind a handler that never resolves, trading a crash for a
 * silent stall. Every row asserts the same three things — the later messages still arrive, still in
 * ascending order, and nothing reached the process.
 */
const FAILING_HANDLERS: Array<{ name: string; make: (seen: string[]) => MessageHandler }> = [
  {
    name: 'throws on the first message only',
    make: (seen) => {
      let first = true;
      return (m) => {
        seen.push(m.content);
        if (!first) return;
        first = false;
        throw new Error('handler exploded');
      };
    },
  },
  {
    name: 'throws on every message',
    make: (seen) => (m) => {
      seen.push(m.content);
      throw new Error('handler exploded');
    },
  },
  {
    name: 'throws a non-Error',
    make: (seen) => (m) => {
      seen.push(m.content);
      throw 'handler exploded';
    },
  },
  {
    name: 'rejects on the first message only',
    make: (seen) => {
      let first = true;
      const handler = async (m: Message): Promise<void> => {
        seen.push(m.content);
        if (!first) return;
        first = false;
        throw new Error('handler rejected');
      };
      return handler;
    },
  },
  {
    name: 'rejects on every message',
    make: (seen) => {
      const handler = async (m: Message): Promise<void> => {
        seen.push(m.content);
        throw new Error('handler rejected');
      };
      return handler;
    },
  },
  {
    name: 'rejects with a non-Error',
    make: (seen) => {
      const handler = async (m: Message): Promise<void> => {
        seen.push(m.content);
        throw 'handler rejected';
      };
      return handler;
    },
  },
  {
    name: 'rejects asynchronously, a turn after it returned',
    make: (seen) => {
      const handler = async (m: Message): Promise<void> => {
        seen.push(m.content);
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('handler rejected late');
      };
      return handler;
    },
  },
  {
    name: 'never settles',
    make: (seen) => {
      const handler = (m: Message): Promise<void> => {
        seen.push(m.content);
        return new Promise<void>(() => undefined);
      };
      return handler;
    },
  },
];

const FAILING_PUSHES = 5;

describe("slack socket mode: a handler's failure never leaves the handler", () => {
  for (const behaviour of FAILING_HANDLERS) {
    it(`a handler that ${behaviour.name}: later events still arrive in order, nothing escapes`, async () => {
      const h = await harness();
      const watch = watchForCrashes();
      try {
        const seen: string[] = [];
        await h.plugin.subscribe(h.topic, behaviour.make(seen));

        const before = new Set(h.fake.pushed);
        const texts = Array.from({ length: FAILING_PUSHES }, (_u, i) => `m${i}`);
        for (const text of texts) {
          h.fake.pushEvent(h.topic, { ts: h.fake.mintTs(), text, user: 'U0X' });
        }
        await vi.waitFor(() => expect(seen).toEqual(texts), { timeout: 3000, interval: 10 });

        // An escaped rejection is reported a turn of the loop later than the throw that caused it.
        await new Promise((r) => setTimeout(r, 100));
        expect(watch.crashes, "the handler's failure reached the process").toEqual([]);

        const ids = [...h.fake.pushed].filter((p) => !before.has(p));
        expect(ids).toHaveLength(FAILING_PUSHES);
        for (const id of ids) expect(h.fake.acked, `unacked: ${id}`).toContain(id);
      } finally {
        watch.stop();
        await h.cleanup();
      }
    });
  }
});

/**
 * CLASS: a vendor-signalled rotation must not drop live events. Slack sends
 * `{type:'disconnect', reason:'warning'}` ~10 s ahead of a routine refresh precisely so a client can
 * establish the replacement FIRST and drain the old connection. Closing on the warning converts a
 * zero-gap rotation into a dial-round-trip gap — and because `subscribe` restarts at the tail and
 * core's push loop performs no periodic catch-up, every event in that gap is lost to the live path
 * for the rest of the session.
 */
const DISCONNECT_REASONS: Array<{ reason?: string; preOpens: boolean }> = [
  { reason: 'warning', preOpens: true },
  { reason: 'refresh_requested', preOpens: false },
  { reason: 'link_disabled', preOpens: false },
  { reason: undefined, preOpens: false },
];

describe('slack socket mode: disconnect reason drives the rotation', () => {
  for (const { reason, preOpens } of DISCONNECT_REASONS) {
    for (const parked of [false, true] as const) {
      it(`reason=${String(reason)} ${preOpens ? 'opens the replacement first' : 'closes at once'}, with a blocking fetch ${parked ? 'parked' : 'absent'}`, async () => {
        const h = await harness();
        try {
          const live: Message[] = [];
          await h.plugin.subscribe(h.topic, (m) => live.push(m));
          const blocked = parked
            ? h.plugin.fetchRecent({ topic: h.topic, since: asCursor('0'), blockMs: 4000 })
            : undefined;
          if (parked) await new Promise((r) => setTimeout(r, 250));
          expect(h.fake.liveSockets).toBe(1);
          const dialsBefore = h.fake.connectionsOpened;

          h.fake.pushUnackedEnvelope({
            ...(reason === undefined ? {} : { reason }),
            type: 'disconnect',
          });

          if (preOpens) {
            // The replacement is up while the old socket is still serving: that overlap IS the grace
            // Slack sends the warning for, and it is the only shape with no gap.
            await vi.waitFor(() => expect(h.fake.liveSockets).toBe(2), {
              timeout: 4000,
              interval: 5,
            });
            // A message pushed DURING the rotation window still reaches the handler — the class guard.
            const mid = h.fake.seed(h.topic, [{ text: 'mid-rotation' }])[0]!;
            h.fake.pushEvent(h.topic, { ts: mid.ts, text: 'mid-rotation', user: 'U0HUMAN' });
            await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('mid-rotation'), {
              timeout: 4000,
              interval: 5,
            });
            // Slack then closes the old half; exactly one socket must be live once it settles.
            h.fake.dropOldestSocket();
          }

          // Exactly ONE handshake per rotation, and exactly one socket left holding the stream —
          // a count of 1 taken before the old socket closed would pass without a rotation at all.
          await vi.waitFor(
            () => {
              expect(h.fake.connectionsOpened, 'replacement handshake').toBe(dialsBefore + 1);
              expect(h.fake.liveSockets, 'sockets after rotation').toBe(1);
            },
            { timeout: 6000, interval: 10 },
          );
          await h.plugin.post(h.topic, asHandle('writer'), 'after rotate');
          await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('after rotate'), {
            timeout: 4000,
            interval: 10,
          });
          if (blocked !== undefined) {
            const result = await blocked;
            expect(result.messages.length, 'the parked fetch still returns a page').toBeGreaterThan(0);
          }
        } finally {
          await h.cleanup();
        }
      });
    }
  }

  // An envelope is untrusted input, so the grace must not become a dial amplifier: a flood of
  // warnings on one socket buys exactly one replacement.
  it('a flood of warnings on one socket costs exactly one extra handshake', async () => {
    const h = await harness();
    try {
      await h.plugin.subscribe(h.topic, () => undefined);
      const dialsBefore = h.fake.connectionsOpened;
      for (let i = 0; i < 40; i++) {
        h.fake.pushUnackedEnvelope({ type: 'disconnect', reason: 'warning' });
      }
      await vi.waitFor(() => expect(h.fake.liveSockets).toBe(2), { timeout: 4000, interval: 5 });
      await new Promise((r) => setTimeout(r, 400));
      expect(h.fake.connectionsOpened - dialsBefore, 'extra handshakes').toBe(1);
      expect(h.fake.liveSockets, 'sockets inside the rotation grace').toBe(2);
    } finally {
      await h.cleanup();
    }
  });
});
