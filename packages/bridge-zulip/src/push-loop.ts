import type { Message, MessageHandler, Topic } from '@sharptrick/parley-core';
import type { QueueState, ZulipConnection } from './connection.js';
import { longPollDeadlineMs, loopBackoffMs, reportsLoopFailure } from './pacing.js';
import { asArray, type EventsResponse, zulipToMessage } from './wire.js';

/**
 * The live path (DESIGN §9 — genuine events, not a poll timer). The queue is awaited before this
 * resolves, so a post immediately after subscribe() is guaranteed to be queued, and Zulip delivers
 * our own sends to our own queue, matching the seam's echo expectation.
 *
 * Delivery is a subset of the tail (DESIGN §6) — but never a repeat. Keep `lastDeliveredId`: an
 * event carrying an id the loop cannot ack leaves the queue position unmoved, and the server then
 * hands back the message behind it on every poll until the fault clears.
 */
const replacedDuringHandshake = (): Error =>
  new Error(
    'Zulip connection was replaced while subscribe() was registering its event queue, so no ' +
      'subscription exists on the connection this call addressed. Reissue it.',
  );

export async function startPushLoop(
  conn: ZulipConnection, topic: Topic, handler: MessageHandler,
): Promise<void> {
  const generation = conn.generation;
  const signal = conn.teardown.signal;
  const alive = (): boolean => !conn.stopped && conn.generation === generation;
  const wire = conn.claimWireTopic(topic);
  // Keep the queue's own transport pinned here, so that abandoning it drops it on the server that
  // minted it rather than offering its id to whatever connection replaced this one.
  const rest = conn.rest;
  // Keep BOTH handshake round trips on the teardown signal, so that a `disconnect()` landing while
  // a server answers neither cuts them instead of returning with them still in flight — the CLI
  // calls `process.exit(0)` the moment shutdown resolves, so whatever is still in flight then is
  // killed mid-request rather than finished.
  /** The newest message id handed to the handler; anything at or below it has already gone out. */
  let lastDeliveredId: number | undefined;
  let reg: Awaited<ReturnType<typeof rest.register>>;
  try {
    reg = await rest.register(wire, signal);
  } catch (err) {
    if (alive()) throw err;
    throw replacedDuringHandshake();
  }
  if (!alive()) {
    // Keep this delete, so that a register that answered just before teardown does not leave its
    // queue behind: this is the only arm that ever learns the id, since an aborted one never reads
    // the response that carries it.
    await rest.deleteQueue(reg.queue_id);
    throw replacedDuringHandshake();
  }
  const state: QueueState = { queueId: reg.queue_id };
  conn.queues.add(state);

  let lastEventId = reg.last_event_id;
  let consecutiveFailures = 0;
  /** Whether `state.queueId` has ever answered an events poll — the only proof push works. */
  let queueProven = false;
  /**
   * Whether the next poll asks the server to PARK. Cleared by a cap so the poll after one asks for
   * whatever is queued right now: our own cap aborts a healthy idle park and a black-holed one
   * without a byte either way, and a non-blocking poll — which a live server must answer at once —
   * is the only thing that tells them apart.
   */
  let parking = true;
  const deliver = (m: Message): void => {
    if (!alive()) return;
    try {
      handler(m);
    } catch {
      /* handler is best-effort; never break the loop (DESIGN §6) */
    }
  };
  const backoff = async (reason: string): Promise<void> => {
    consecutiveFailures++;
    if (reportsLoopFailure(consecutiveFailures)) {
      console.error(
        `[parley-zulip] push loop for topic ${JSON.stringify(topic)} has failed ` +
          `${consecutiveFailures}× in a row (${reason}); still retrying, backing off`,
      );
    }
    await conn.interruptibleDelay(loopBackoffMs(consecutiveFailures));
  };

  /** One pass of the push loop; `false` ends it. */
  const advance = async (): Promise<boolean> => {
    const controller = new AbortController();
    conn.controllers.add(controller);
    let capped = false;
    const timer = setTimeout(() => {
      capped = true;
      controller.abort();
    }, conn.cfg.eventsTimeoutMs);
    const parked = parking;
    let json: EventsResponse;
    try {
      const res = await rest.poll(state.queueId, lastEventId, parked, {
        signal: controller.signal,
        deadlineMs: longPollDeadlineMs(conn.cfg.eventsTimeoutMs),
      });
      json = ((await res.json()) as EventsResponse | null) ?? {};
    } catch {
      if (!alive()) return false;
      // Keep the cap of a PARKED poll off the failure path, so that the healthy idle cap is never
      // escalated into backoff on every long-poll cycle. A poll that asked for what is already
      // queued has no such excuse: capping THAT one is a server producing no bytes at all.
      if (capped && parked) parking = false;
      else {
        await backoff(
          capped
            ? 'an events poll asking for the queue as it stands produced no response'
            : 'events long-poll failed',
        );
      }
      return true;
    } finally {
      clearTimeout(timer);
      conn.controllers.delete(controller);
    }
    parking = true;
    if (!alive()) return false;
    if (json.result === 'error') {
      if (json.code === 'BAD_EVENT_QUEUE_ID') {
        try {
          const superseded = state.queueId;
          const fresh = await rest.register(wire, signal);
          conn.deleteQueueDetached(rest, superseded);
          state.queueId = fresh.queue_id;
          lastEventId = fresh.last_event_id;
          // A queue rejected before it ever answered a poll is a FAILING recovery, not a
          // completed one: pace it, so that a server rejecting every queue it mints cannot be
          // flooded with fresh registrations by its own error.
          if (!queueProven) await backoff('a freshly registered event queue was rejected as stale');
          queueProven = false;
        } catch {
          if (!alive()) return false;
          await backoff('re-register after queue GC failed');
        }
      } else {
        await backoff(`events poll returned ${json.code ?? 'an error'}`);
      }
      return true;
    }
    queueProven = true;
    let acked = false;
    for (const ev of asArray(json.events)) {
      if (typeof ev?.id === 'number' && ev.id > lastEventId) {
        lastEventId = ev.id; // ack heartbeats too
        acked = true;
      }
      if (ev?.type !== 'message') continue;
      const m = zulipToMessage(topic, ev.message);
      if (m === undefined) continue;
      const id = Number(m.backendMsgId);
      if (lastDeliveredId !== undefined && id <= lastDeliveredId) continue;
      lastDeliveredId = id;
      deliver(m);
    }
    // Grade the answer on whether it MOVED the queue, not on whether it carried bytes: a parked
    // poll the ack cannot advance past is re-issued unchanged forever. Keep it paced, so that a
    // server ignoring `dont_block=false` — or answering with no events, stale ids, or ids that
    // are not numbers at all — cannot turn the loop into a request flood that grades itself
    // healthy. A live queue's own heartbeat carries a fresh id, so an idle queue stays off this.
    if (parked && !acked) {
      await backoff('an events poll that asked to park answered without advancing the queue');
      return true;
    }
    // Keep the failure-escalation reset at the END of a whole successful pass, so that a recovery
    // step that always succeeds — a gap-fill read, a re-register — cannot cancel the backoff
    // protecting the server from a cycle that fails at the step after it.
    consecutiveFailures = 0;
    return true;
  };

  const loop = async (): Promise<void> => {
    while (alive()) {
      // Keep the catch around the WHOLE pass, so that no throw a server's payload can provoke —
      // outside the awaits that guard themselves — ends push for this topic or escapes as an
      // unhandled rejection that takes the MCP process with it.
      try {
        if (!(await advance())) break;
      } catch (err) {
        if (!alive()) break;
        await backoff(`an unexpected push-loop failure: ${String(err)}`);
      }
    }
  };
  // Keep this catch even with nothing left to report, so that a throw from the loop's own failure
  // reporting cannot reach Node as an uncaught exception and take the MCP stdio server down.
  const running = loop().catch(() => undefined);
  conn.loopExits.add(running);
  void running.finally(() => conn.loopExits.delete(running));
}
