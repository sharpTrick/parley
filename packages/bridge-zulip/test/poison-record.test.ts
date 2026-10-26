/**
 * This backend's poison record: a `message` object whose `content` cannot be READ. `ZulipMessage`
 * is an interface over a server-controlled record, and nothing in it promises a plain data
 * property — but a body that arrived as JSON cannot carry an accessor, so this shape is reachable
 * through the type and not through the wire. The invariant it grades is reachable through both:
 * the loop acks every event id BEFORE it delivers, so a conversion that throws outside the
 * delivery containment loses every event behind it for good and reports the loss as an outage.
 */
import {
  expectPoisonCostsOneMessage,
  POISON_RECORD_CLAUSE,
} from '@sharptrick/parley-conformance';
import { asTopic, type Message } from '@sharptrick/parley-core';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { ZulipConnection } from '../src/connection.js';
import type { ZulipHttp } from '../src/http.js';
import { startPushLoop } from '../src/push-loop.js';
import type { EventsResponse, ZulipMessage } from '../src/wire.js';

const T = asTopic('poison');

const unreadable: ZulipMessage = {
  id: 2,
  get content(): string {
    throw new Error('this record cannot be converted');
  },
};

let conn: ZulipConnection | undefined;

afterEach(async () => {
  await conn?.close();
  conn = undefined;
  vi.restoreAllMocks();
});

it(POISON_RECORD_CLAUSE, async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  conn = new ZulipConnection();
  conn.open(resolveConfig({}));

  const batch: EventsResponse = {
    events: [
      { id: 1, type: 'message', message: { id: 1, content: 'first' } },
      { id: 2, type: 'message', message: unreadable },
      { id: 3, type: 'message', message: { id: 3, content: 'third' } },
    ],
  };
  let served = false;
  let heartbeat = 3;
  // Keep the idle answers on a real timer, so that the loop yields the event loop between passes:
  // a server that answers within a microtask starves every macrotask this test schedules.
  const idle = async (): Promise<EventsResponse> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { events: [{ id: ++heartbeat, type: 'heartbeat' }] };
  };
  conn.rest = {
    register: () => Promise.resolve({ queue_id: 'q', last_event_id: 0 }),
    poll: () =>
      Promise.resolve({
        json: (): Promise<EventsResponse> => {
          if (served) return idle();
          served = true;
          return Promise.resolve(batch);
        },
      }),
    deleteQueue: () => Promise.resolve(),
  } as unknown as ZulipHttp;

  const delivered: Message[] = [];
  await startPushLoop(conn, T, (m) => {
    delivered.push(m);
  });

  await expectPoisonCostsOneMessage({
    survivors: ['first', 'third'],
    plant: () => undefined,
    settle: async () => {
      const deadline = Date.now() + 2000;
      while (delivered.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    delivered: () => delivered.map((m) => m.content),
    stillHealthy: {
      report: () =>
        consoleError.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[parley-zulip]')),
      expected: [],
    },
  });
  expect(delivered).toHaveLength(2);
});
