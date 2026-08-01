import type { Topic } from '@sharptrick/parley-core';
import { delay } from '@sharptrick/parley-net-util';
import { resolveConfig, type ZulipConfig } from './config.js';
import { TEARDOWN_TIMEOUT_MS, ZulipHttp } from './http.js';
import { requireWireTopic } from './wire.js';

export interface QueueState {
  queueId: string;
}

export interface TopicWaiters {
  readonly wakes: Set<() => void>;
  healthy: number;
}

/**
 * A single bounded wait for "a message may have landed on this topic", however it is obtained.
 * Keep `release` synchronous, so that no teardown a wake owns can run inside the caller's `blockMs`.
 */
export interface Wake {
  readonly waited: Promise<void>;
  readonly release: () => void;
}

/**
 * The live connection: the registries every seam call and every push loop addresses, the transport
 * bound to the config the connection was opened with, and the teardown that ends all of it.
 */
export class ZulipConnection {
  connected = false;
  stopped = false;
  /**
   * Bumped by every `connect`/`disconnect`. A push loop captures it at subscribe time and stops
   * the moment it changes, so a loop parked in a backoff across a disconnect cannot be resurrected
   * by the next `connect()` and replay into a handler whose subscription is gone.
   */
  generation = 0;
  cfg: ZulipConfig = resolveConfig({});
  rest = new ZulipHttp(this.cfg, () => this.stopped);
  /** Aborted by `disconnect`, so a loop's in-flight history read cannot outlive its subscription. */
  teardown = new AbortController();
  /** Push loops still running, awaited by `disconnect` so no handler can fire after it resolves. */
  readonly loopExits = new Set<Promise<void>>();
  /** In-flight event long-polls, aborted on disconnect so teardown is immediate. */
  readonly controllers = new Set<AbortController>();
  /** Live queues (one per subscribe), so disconnect can best-effort delete them server-side. */
  readonly queues = new Set<QueueState>();
  /**
   * Topics with a live `subscribe` loop → its wake callbacks for blocking `fetchRecent` calls
   * piggybacking on that loop's already-registered event queue. `healthy` counts only the loops on
   * the topic that can still deliver, so a blocked fetch can never park behind a subscription that
   * will not wake it; the loop fires the callbacks on a delivery so a blocked fetch re-queries
   * WITHOUT opening a second event queue for the topic. A loop can only end by the connection
   * ending, so it is `disconnect()` that empties this and releases whoever is parked here.
   */
  readonly waiters = new Map<Topic, TopicWaiters>();
  /**
   * Wire topic → the one Parley topic that claimed it by WRITING there, so a case-fold collision
   * fails fast. Only `post` and `subscribe` claim: a read addresses history it did not create, and a
   * registry a read can write is a namespace any caller-supplied topic name can take hostage.
   */
  private readonly claimedWireTopics = new Map<string, Topic>();
  /**
   * Releases for every in-flight timed wait, fired on `disconnect()` so each ends immediately with
   * no leaked timer or listener — the same teardown discipline as the event-poll controllers.
   */
  private readonly pendingAborts = new Set<() => void>();
  /**
   * Queue deletions detached from a caller's deadline, awaited by `disconnect()` so best-effort
   * cleanup still finishes without ever running inside a `fetchRecent`'s `blockMs`.
   */
  private readonly pendingDeletes = new Set<Promise<void>>();

  open(cfg: ZulipConfig): void {
    this.cfg = cfg;
    this.rest = new ZulipHttp(cfg, () => this.stopped);
    this.claimedWireTopics.clear();
    this.generation++;
    this.teardown = new AbortController();
    this.stopped = false;
    this.connected = true;
  }

  /**
   * Tears down every subscription as well as the connection: the generation bump orphans each push
   * loop, the aborts end whatever it is parked in, and the loops are then awaited before teardown
   * returns. Keep the generation bump ahead of those awaits, so that a loop outliving its bounded
   * wait still cannot deliver into a subscription that is already gone.
   */
  async close(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.claimedWireTopics.clear();
    this.teardown.abort();
    for (const abort of this.pendingAborts) abort();
    this.pendingAborts.clear();
    this.waiters.clear();
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    const exits = [...this.loopExits];
    this.loopExits.clear();
    await Promise.race([Promise.allSettled(exits), delay(TEARDOWN_TIMEOUT_MS)]);
    const queues = [...this.queues];
    this.queues.clear();
    await Promise.allSettled(queues.map((q) => this.rest.deleteQueue(q.queueId)));
    await Promise.allSettled([...this.pendingDeletes]);
    this.connected = false;
  }

  /**
   * Drop a queue the plugin has stopped using without making anyone wait for the round trip. Keep
   * it off every caller's path, so that a slow or black-holed server cannot spend a `fetchRecent`'s
   * `blockMs` — or a push loop's recovery latency — on cleanup. Keep `rest` the caller's rather than
   * this connection's, so that a delete racing a reconnect drops the queue on the server that minted
   * it instead of offering its id to whatever replaced that connection.
   */
  deleteQueueDetached(rest: ZulipHttp, queueId: string): void {
    const done = rest.deleteQueue(queueId);
    this.pendingDeletes.add(done);
    void done.finally(() => this.pendingDeletes.delete(done));
  }

  /** An abort firing at `deadline` or on `disconnect()`; `done()` releases timer and registrations. */
  deadlineAbort(deadline: number): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
    this.pendingAborts.add(abort);
    this.controllers.add(controller);
    return {
      signal: controller.signal,
      done: (): void => {
        clearTimeout(timer);
        this.pendingAborts.delete(abort);
        this.controllers.delete(controller);
      },
    };
  }

  /**
   * A wait ending at `ms`, on `disconnect()`, or when whoever holds `extra` fires it — once, with
   * every registration undone. Keep the `stopped` re-check after the registration, so that a
   * teardown racing the arming cannot leave the wait parked with nothing left to release it.
   */
  timedWait(ms: number, extra?: Set<() => void>): Wake {
    let release!: () => void;
    const waited = new Promise<void>((resolve) => {
      let done = false;
      release = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        extra?.delete(release);
        this.pendingAborts.delete(release);
        resolve();
      };
      const timer = setTimeout(release, ms);
      this.pendingAborts.add(release);
      extra?.add(release);
      if (this.stopped) release();
    });
    return { waited, release };
  }

  /** A pause that also ends on `disconnect()`, so that teardown never waits out a backoff. */
  async interruptibleDelay(ms: number): Promise<void> {
    if (this.stopped || ms <= 0) return;
    await this.timedWait(ms).waited;
  }

  /** Release every blocking `fetchRecent` piggybacking on `topic`'s live subscribe loop(s). */
  wake(topic: Topic): void {
    const live = this.waiters.get(topic);
    if (live !== undefined) for (const wake of [...live.wakes]) wake();
  }

  /**
   * {@link requireWireTopic}, plus the collision two Parley topics differing only in case would
   * otherwise share: Zulip matches topics case-insensitively, so the second one to claim a wire
   * name would silently be reading and writing the first one's history.
   */
  wireTopic(topic: Topic): string {
    const wire = requireWireTopic(topic);
    const claimed = this.claimedWireTopics.get(wire);
    if (claimed !== undefined && claimed !== topic) {
      throw new Error(
        `Zulip topic collision: Parley topics ${JSON.stringify(claimed)} and ` +
          `${JSON.stringify(topic)} both map to Zulip topic ${JSON.stringify(wire)} — Zulip ` +
          'matches topics case-insensitively, so they would share one history. Rename one.',
      );
    }
    return wire;
  }

  /**
   * The Zulip topic a WRITE addresses: `post`'s send and `subscribe`'s queue are the durable state a
   * case-fold collision would merge, so they are the only paths that claim the wire name. Keep reads
   * out of here, so that reading a case variant of a configured topic cannot make every later write
   * to that topic fail for the life of the process.
   */
  claimWireTopic(topic: Topic): string {
    const wire = this.wireTopic(topic);
    this.claimedWireTopics.set(wire, topic);
    return wire;
  }

  require(): void {
    if (!this.connected) throw new Error('ZulipPlugin not connected — call connect() first');
  }

  /**
   * Refuse to carry on against a connection the caller did not address. Keep every seam call on this
   * after the awaits it makes, so that one parked in a request across a `disconnect()`/`connect()`
   * cannot resume on the NEXT connection — a cursor minted in one server's id space would then be
   * answered out of another server's history, and the caller would store the wrong space's id.
   */
  assertGeneration(generation: number): void {
    if (this.generation === generation) return;
    throw new Error(
      'Zulip connection was replaced while this call was in flight, so it can no longer be ' +
        'answered from the connection it addressed. Reissue it.',
    );
  }
}
