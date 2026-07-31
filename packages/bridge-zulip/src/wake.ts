import type { Cursor, Message, Topic } from '@sharptrick/parley-core';
import type { QueueState, Wake, ZulipConnection } from './connection.js';
import { readWindow } from './history.js';
import { blockedFetchPause, budgetedDeadlineMs } from './pacing.js';
import { asArray, type EventsResponse } from './wire.js';

/**
 * Wait until `deadline` for a message strictly after `since`, then re-run the normal exclusive
 * query and return it (possibly empty, with a cursor === `since`, which is correct at timeout).
 *
 * Each pass arms the best wake primitive currently available ({@link armWake}), re-checks history
 * with that primitive already live, then waits on it. Re-evaluating every pass is what keeps the
 * wait honest when the backend's state changes mid-flight: a `subscribe` loop that falls into
 * failure backoff, re-registration or exit stops being a usable wake source, and the next pass
 * degrades to a dedicated queue rather than parking out the caller's whole budget behind it.
 */
export async function blockingFetch(
  conn: ZulipConnection, topic: Topic, since: Cursor,
  limit: number, deadline: number, generation: number,
): Promise<Message[]> {
  const read = async (): Promise<Message[]> =>
    (await readWindow(conn, topic, since, limit, { generation, deadline })).messages;
  for (let attempt = 0; !conn.stopped && Date.now() < deadline; attempt++) {
    const wake = await armWake(conn, topic, deadline, blockedFetchPause(attempt), generation);
    try {
      const raced = conn.stopped ? [] : await read();
      if (raced.length > 0) return raced;
      await wake.waited;
    } finally {
      wake.release();
    }
    if (conn.stopped) return [];
    const got = await read();
    if (got.length > 0) return got;
  }
  return [];
}

/**
 * The best wake edge available for `topic` right now, already armed and bounded by `deadline`: a
 * live `subscribe` loop's queue when one is draining the topic, otherwise a short-lived one of ours.
 *
 * Keep the piggyback registration on the synchronous path — before this function's first `await`
 * — so that a wake fired between the caller's history read and the registration cannot be lost.
 * Keep the disconnect check here rather than in each arm, so that neither can be reached after
 * teardown and neither has to re-check for it.
 */
async function armWake(
  conn: ZulipConnection, topic: Topic, deadline: number, pauseMs: number, generation: number,
): Promise<Wake> {
  if (conn.stopped || conn.generation !== generation) {
    return { waited: Promise.resolve(), release: () => undefined };
  }
  const live = conn.waiters.get(topic);
  if (live !== undefined && live.healthy > 0) {
    return conn.timedWait(Math.max(0, deadline - Date.now()), live.wakes);
  }
  return armDedicatedQueue(conn, topic, deadline, pauseMs);
}

/**
 * No usable subscription for this topic: register a short-lived narrowed event queue and issue
 * one `/api/v1/events` long-poll bounded by the remaining budget. When the queue or the poll is
 * unavailable — the whole reason a caller can end up here — the wait degrades to a bounded pause
 * so the caller's next history read still lands inside its budget instead of at the end of it.
 */
async function armDedicatedQueue(
  conn: ZulipConnection, topic: Topic, deadline: number, pauseMs: number,
): Promise<Wake> {
  let reg: { queue_id: string; last_event_id: number };
  // Bound the registration by the caller's deadline too: a slow or black-holed register is
  // otherwise a wait the caller never asked for, ahead of the wait it did.
  const bound = conn.deadlineAbort(deadline);
  try {
    reg = await conn.rest.register(conn.wireTopic(topic), bound.signal, budgetedDeadlineMs(deadline));
  } catch {
    return { waited: pause(conn, deadline, pauseMs), release: () => undefined };
  } finally {
    bound.done();
  }
  const state: QueueState = { queueId: reg.queue_id };
  conn.queues.add(state);
  return {
    waited: pollForWake(conn, reg, deadline, pauseMs),
    release: () => {
      conn.queues.delete(state);
      conn.deleteQueueDetached(reg.queue_id);
    },
  };
}

/**
 * One `/api/v1/events` long-poll on a dedicated queue, resolving on the wake edge (a matching
 * message), at `deadline`, or on disconnect. The events themselves are discarded — the caller
 * re-reads history — so an outright failure only costs the caller a bounded pause.
 *
 * Keep the pace on EVERY answer that carries no message, not just on a non-2xx: a poll answered
 * at once with a heartbeat, with no events, or by a server ignoring `dont_block=false` is a wake
 * that never came, and each pass mints and drops a fresh event queue.
 */
async function pollForWake(
  conn: ZulipConnection, reg: { queue_id: string; last_event_id: number },
  deadline: number, pauseMs: number,
): Promise<void> {
  if (conn.stopped || deadline - Date.now() <= 0) return;
  const bound = conn.deadlineAbort(deadline);
  try {
    const res = await conn.rest.poll(reg.queue_id, reg.last_event_id, true, {
      signal: bound.signal,
      deadlineMs: budgetedDeadlineMs(deadline),
    });
    const woke =
      res.ok &&
      asArray(((await res.json()) as EventsResponse | null)?.events).some(
        (e) => e?.type === 'message',
      );
    if (!woke) await pause(conn, deadline, pauseMs);
  } catch {
    if (!bound.signal.aborted) await pause(conn, deadline, pauseMs);
  } finally {
    bound.done();
  }
}

/** A pause that never outlives `deadline` or a disconnect. */
function pause(conn: ZulipConnection, deadline: number, ms: number): Promise<void> {
  return conn.interruptibleDelay(Math.min(ms, deadline - Date.now()));
}
