import type { Topic } from '@sharptrick/parley-core';
import type { Client } from 'pg';
import { LISTENER_WAIT_MS, PostgresListener } from './listener.js';
import { channelFor } from './schema.js';

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
   * Park up to `blockMs` waiting for a NOTIFY on `topic`'s channel, then return so the caller can
   * re-run the exclusive `since` query. The doorbell is the one `subscribe` waits on, piggybacking
   * a live subscription's LISTEN through {@link acquireListen} when there is one. Any wake, the
   * `blockMs` timer, or `disconnect()` releases the wait, and the timer is always cleared.
   */
  protected async waitForNotify(
    topic: Topic,
    since: string,
    limit: number,
    blockMs: number,
  ): Promise<void> {
    const epoch = this.epoch;
    let listener: Client;
    try {
      listener = await this.ensureListener(Math.min(blockMs, LISTENER_WAIT_MS));
    } catch {
      return; // listener unavailable → skip the native wait; core polls the remaining budget
    }
    if (this.stopped || epoch !== this.epoch) return;
    const channel = channelFor(topic);

    let listen: ListenState;
    try {
      listen = await this.acquireListen(listener, channel);
    } catch {
      return; // LISTEN failed → skip the native wait; core polls the remaining budget
    }
    const set = this.waiters.get(channel) ?? new Set<() => void>();
    this.waiters.set(channel, set);
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pendingAborts.delete(finish);
        set.delete(finish);
        if (set.size === 0) this.waiters.delete(channel);
        this.releaseListen(channel, listen);
        resolve();
      };
      const timer = setTimeout(finish, blockMs);
      this.pendingAborts.add(finish);
      set.add(finish);
      if (this.stopped || epoch !== this.epoch) {
        finish(); // disconnect may have raced registration
        return;
      }
      // Snapshot-window re-check: catch a row that landed between the caller's empty read and the
      // LISTEN above, which sent no NOTIFY we'd hear. If it's there, wake now (caller re-queries);
      // otherwise stay parked. A failed re-check is harmless — the NOTIFY/timer still resolve us.
      void this.readSince(topic, since, limit)
        .then((recheck) => {
          if (recheck.length > 0) finish();
        })
        .catch(() => undefined);
    });
  }
}
