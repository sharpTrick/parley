import type { Message, MessageHandler, Topic } from '@sharptrick/parley-core';
import type { QueueState, ZulipConnection } from './connection.js';
import { gapFill, probeTail } from './history.js';
import { longPollDeadlineMs, loopBackoffMs, reportsLoopFailure } from './pacing.js';
import { asArray, type EventsResponse, zulipToMessage } from './wire.js';

/**
 * The live path (DESIGN §9 — genuine events, not a poll timer). The queue is awaited before this
 * resolves, so a post immediately after subscribe() is guaranteed to be queued, and Zulip delivers
 * our own sends to our own queue, matching the seam's echo expectation.
 *
 * The delivery watermark is probed BEFORE register and the handshake window is then closed by an
 * armed gap-fill, so every message newer than the probe is delivered EXACTLY once. A probe that
 * cannot establish a tail at all ({@link probeTail}) arms no gap-fill: with no watermark to replay
 * FROM, the only honest window is the queue's own.
 *
 * Queue GC: Zulip garbage-collects queues after ~10 min idle and then answers
 * `BAD_EVENT_QUEUE_ID`; recovery re-registers and arms the same gap-fill, which `lastDeliveredId`
 * dedupes against the events the fresh queue then delivers.
 */
export async function startPushLoop(
  conn: ZulipConnection, topic: Topic, handler: MessageHandler,
): Promise<void> {
  const generation = conn.generation;
  const signal = conn.teardown.signal;
  const alive = (): boolean => !conn.stopped && conn.generation === generation;
  const wire = conn.claimWireTopic(topic);
  let lastDeliveredId = await probeTail(conn, topic, generation);
  const reg = await conn.rest.register(wire);
  const state: QueueState = { queueId: reg.queue_id };
  if (!alive()) {
    await conn.rest.deleteQueue(reg.queue_id);
    return;
  }
  conn.queues.add(state);
  // Advertise the topic as piggyback-able only now that every await is behind us and the loop is
  // about to run — a waiter set with no live loop behind it parks a blocking fetchRecent.
  const entry = conn.waiters.get(topic) ?? { wakes: new Set<() => void>(), healthy: 0 };
  entry.healthy++;
  conn.waiters.set(topic, entry);

  let lastEventId = reg.last_event_id;
  // Armed from the pre-register watermark so the register handshake window is replayed, and
  // re-armed by a queue GC; the top of the loop drains it, retrying until the read succeeds so a
  // transient failure can't leave a permanent push hole.
  let needsGapFillFrom: number | undefined = lastDeliveredId;
  let consecutiveFailures = 0;
  let degraded = false;
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
  /** Stop advertising the topic as piggyback-able and release whoever is already parked on it. */
  const degrade = (): void => {
    if (degraded) return;
    degraded = true;
    entry.healthy--;
    conn.wake(topic);
  };
  /** Advertise the topic as piggyback-able again — the loop can deliver, by whatever route. */
  const promote = (): void => {
    if (!degraded) return;
    degraded = false;
    entry.healthy++;
  };
  const backoff = async (reason: string): Promise<void> => {
    degrade();
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
    // Drain a pending gap-fill BEFORE polling the fresh queue — retry the gap (not the events
    // poll) until it clears, advancing `lastDeliveredId`/`needsGapFillFrom` per delivered page
    // so a mid-pagination throw keeps its progress and a retry resumes past delivered pages.
    if (needsGapFillFrom !== undefined) {
      try {
        lastDeliveredId = await gapFill(
          conn, topic, needsGapFillFrom, deliver,
          (id) => {
            lastDeliveredId = id;
            needsGapFillFrom = id;
            conn.wake(topic); // gap-fill is also a delivery — release blocked fetchers
          },
          { generation, signal },
        );
        needsGapFillFrom = undefined; // gap closed — resume normal polling
        promote();
      } catch {
        if (!alive()) return false;
        await backoff('gap-fill history read failed');
      }
      return true; // re-check liveness / re-attempt before polling the fresh queue
    }
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
      const res = await conn.rest.poll(state.queueId, lastEventId, parked, {
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
        // Re-register the queue, then ARM the pending gap — the top of the loop drains it.
        try {
          const superseded = state.queueId;
          const fresh = await conn.rest.register(wire, signal);
          conn.deleteQueueDetached(superseded);
          state.queueId = fresh.queue_id;
          lastEventId = fresh.last_event_id;
          needsGapFillFrom = lastDeliveredId;
          // A queue rejected before it ever answered a poll is a FAILING recovery, not a
          // completed one: pace it, so that a server rejecting every queue it mints cannot be
          // flooded with fresh registrations by its own error.
          if (queueProven) promote();
          else await backoff('a freshly registered event queue was rejected as stale');
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
    let sawMessage = false;
    let acked = false;
    for (const ev of asArray(json.events)) {
      if (typeof ev?.id === 'number' && ev.id > lastEventId) {
        lastEventId = ev.id; // ack heartbeats too
        acked = true;
      }
      if (ev?.type !== 'message') continue;
      const m = zulipToMessage(topic, ev.message);
      if (m === undefined) continue;
      sawMessage = true; // a message landed on this topic — release any blocked fetchers
      const id = Number(m.backendMsgId);
      if (lastDeliveredId !== undefined && id <= lastDeliveredId) continue; // gap-filled — dedup
      lastDeliveredId = id;
      deliver(m);
    }
    // Wake piggybacking blocking-fetch waiters; they re-query and return whatever is newly past
    // their `since`. A spurious wake only ends a wait early, which core covers by re-polling.
    if (sawMessage) conn.wake(topic);
    // Grade the answer on whether it MOVED the queue, not on whether it carried bytes: a parked
    // poll the ack cannot advance past is re-issued unchanged forever. Keep it paced, so that a
    // server ignoring `dont_block=false` — or answering with no events, stale ids, or ids that
    // are not numbers at all — cannot turn the loop into a request flood that grades itself
    // healthy. A live queue's own heartbeat carries a fresh id, so an idle queue stays off this.
    if (parked && !acked) {
      await backoff('an events poll that asked to park answered without advancing the queue');
      return true;
    }
    // Keep the failure-escalation reset here and NOT in `promote`, so that a recovery step that
    // always succeeds — a gap-fill read, a re-register — cannot cancel the backoff protecting the
    // server from a cycle that fails at the step after it.
    consecutiveFailures = 0;
    promote();
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
