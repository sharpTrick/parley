import type { Topic } from '@sharptrick/parley-core';
import type { Client } from 'pg';
import { LISTENER_WAIT_MS, PostgresListener } from './listener.js';
import { channelFor } from './schema.js';
import type { ParkedWaiter } from './state.js';

export interface ListenState {
  /** Resolves only once the LISTEN is ESTABLISHED — never merely intended. */
  ready: Promise<void>;
  /** Participants (subscriptions + in-flight waiters) that still need this channel LISTENed. */
  refs: number;
}

/** Reference-counted LISTENs on the shared connection, and the blocking-fetch doorbell. */
export abstract class PostgresListen extends PostgresListener {
  /**
   * Take a reference on the channel's LISTEN, resolving only once that LISTEN is ESTABLISHED —
   * publishing "someone intends to LISTEN" as if it were "the channel is LISTENed" strands every
   * piggybacking waiter on a doorbell that may never be installed. Rejects (having taken no
   * reference) if the LISTEN failed, so the caller can fall back.
   */
  protected async acquireListen(listener: Client, channel: string): Promise<ListenState> {
    const existing = this.listens.get(channel);
    if (existing !== undefined) {
      existing.refs++;
      try {
        await existing.ready;
      } catch (err) {
        this.releaseListen(channel, existing);
        throw err;
      }
      return existing;
    }
    const entry: ListenState = {
      ready: listener.query(`LISTEN "${channel}"`).then(() => undefined),
      refs: 1,
    };
    this.listens.set(channel, entry);
    try {
      await entry.ready;
    } catch (err) {
      if (this.listens.get(channel) === entry) this.listens.delete(channel);
      throw err;
    }
    return entry;
  }

  protected releaseListen(channel: string, entry: ListenState): void {
    if (this.listens.get(channel) !== entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.listens.delete(channel);
    if (!this.stopped && this.listener !== undefined) {
      void this.listener.query(`UNLISTEN "${channel}"`).catch(() => undefined);
    }
  }

  /**
   * Await `work` under the wait's REMAINING budget and under `disconnect()`, resolving `undefined`
   * when it expired, was torn down, or failed — the caller's action is the same for all three.
   * Every step a native long-poll is armed behind is time its caller is blocked and a wait a
   * teardown must be able to end, and neither is true of a step awaited bare.
   *
   * Keep this abandoning the WAIT and never the resource: the dial and the LISTEN are shared, so a
   * few-millisecond budget ending one would take out a concurrent `subscribe` parked on the same
   * one.
   */
  private armWithin<T>(work: Promise<T>, budgetMs: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let release!: () => void;
    const abandoned = new Promise<undefined>((resolve) => {
      release = (): void => resolve(undefined);
      timer = setTimeout(release, budgetMs);
    });
    this.pendingAborts.add(release);
    return Promise.race([work.catch(() => undefined), abandoned]).finally(() => {
      clearTimeout(timer);
      this.pendingAborts.delete(release);
    });
  }

  /**
   * Park up to `blockMs` waiting for a NOTIFY on `topic`'s channel, then return so the caller can
   * re-run the exclusive `since` query. The doorbell is the one `subscribe` waits on, piggybacking
   * a live subscription's LISTEN through {@link acquireListen} when there is one. Any wake, the
   * `blockMs` timer, or `disconnect()` releases the wait, and the timer is always cleared.
   *
   * `blockMs` is the budget for the WHOLE call — the listener dial and the LISTEN included, both of
   * which queue behind whatever else the shared connection is doing.
   */
  protected async waitForNotify(
    topic: Topic,
    since: string,
    limit: number,
    blockMs: number,
  ): Promise<void> {
    const epoch = this.epoch;
    const deadline = Date.now() + blockMs;
    const remaining = (): number => Math.max(0, deadline - Date.now());

    const listener = await this.armWithin(
      this.ensureListener(Math.min(blockMs, LISTENER_WAIT_MS)),
      remaining(),
    );
    if (listener === undefined) return; // no listener in budget → core polls what is left
    if (this.stopped || epoch !== this.epoch) return;
    const channel = channelFor(topic);

    const acquiring = this.acquireListen(listener, channel);
    const listen = await this.armWithin(acquiring, remaining());
    if (listen === undefined) {
      // `acquireListen` took the reference synchronously, so hand it back if the LISTEN lands after
      // this wait gave up — otherwise the channel is refcounted forever and never UNLISTENed.
      void acquiring.then(
        (late) => this.releaseListen(channel, late),
        () => undefined,
      );
      return; // no LISTEN in budget → core polls what is left
    }
    const set = this.waiters.get(channel) ?? new Set<ParkedWaiter>();
    this.waiters.set(channel, set);
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pendingAborts.delete(finish);
        set.delete(parked);
        if (set.size === 0) this.waiters.delete(channel);
        this.releaseListen(channel, listen);
        resolve();
      };
      // Wake only if the row is really there, for every window that starves this wait without a
      // NOTIFY behind it to prove one landed: the snapshot between the caller's empty read and the
      // LISTEN below, and every later blackout the reconnect recovers from.
      const recheck = (): void => {
        void (async () => {
          if ((await this.readSince(topic, since, limit)).length > 0) finish();
        })().catch(() => undefined);
      };
      const parked: ParkedWaiter = { wake: finish, recheck };
      const timer = setTimeout(finish, remaining());
      this.pendingAborts.add(finish);
      set.add(parked);
      if (this.stopped || epoch !== this.epoch) {
        finish(); // disconnect may have raced registration
        return;
      }
      recheck();
    });
  }
}
