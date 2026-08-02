import type { Topic } from '@sharptrick/parley-core';
import type { Client, Pool } from 'pg';
import { DEFAULT_TABLE_NAME, DEFAULT_URL } from './config.js';
import type { ListenState } from './listen.js';
import type { TopicSubscription } from './push.js';
import { messagesSince } from './read.js';
import { type MessageRow, quotedNames, type SchemaNames } from './schema.js';

/** One parked blocking `fetchRecent`, as the paths that have to serve it see it. */
export interface ParkedWaiter {
  /** End the wait now; the caller re-runs its own exclusive `since` query. */
  wake: () => void;
  /** Re-run that query here and wake only if it finds something — for a wake nothing rang for. */
  recheck: () => void;
}

/** The state one connected plugin carries; the layers above it add the behaviour. */
export abstract class PluginState {
  protected pool?: Pool;
  protected url = DEFAULT_URL;
  /** Relation names already double-quoted — the only spelling that may reach SQL text. */
  protected names: SchemaNames = quotedNames(DEFAULT_TABLE_NAME);
  protected retentionDays?: number;
  protected pruneTimer?: ReturnType<typeof setInterval>;
  protected stopped = false;
  /**
   * Bumped by every `disconnect()`. Compare it, not `stopped`, after any await in a chore that
   * mutates shared state — `connect()` sets `stopped` back to false, so a chore that slept across
   * a whole teardown/restart sees `stopped === false` and would publish into the NEW lifecycle.
   */
  protected epoch = 0;

  /**
   * Resources a setup call has built but not yet published — the bootstrap pool, a listener socket
   * still coming up. Publish into this BEFORE the await that brings one up, so that a
   * `disconnect()` landing inside that window has something to end and the call it raced finds its
   * slot taken; a `delete` that returns false is that call's proof it was superseded.
   */
  protected readonly starting = new Set<{ end: () => Promise<void> }>();

  /** Dedicated non-pool LISTEN connection, shared by all topics; lazy on first subscribe. */
  protected listener?: Client;
  protected listenerPromise?: Promise<Client>;
  protected reconnecting = false;
  protected readonly subs = new Map<string, TopicSubscription>();
  /**
   * Channels whose first `subscribe` is still mid-flight, so a concurrent `subscribe` to the same
   * topic joins that one instead of building a second {@link TopicSubscription} that overwrites it.
   */
  protected readonly subscribing = new Map<string, Promise<TopicSubscription>>();

  /**
   * Blocking `fetchRecent` waiters keyed by NOTIFY channel, parked on the SAME doorbell `subscribe`
   * waits on. The notification handler fans a NOTIFY out to every registered waiter.
   */
  protected readonly waiters = new Map<string, Set<ParkedWaiter>>();
  /** Established (or in-flight) LISTENs by channel — see {@link acquireListen}. */
  protected readonly listens = new Map<string, ListenState>();
  /**
   * Every in-flight blocking-fetch wait's release callback, fired on `disconnect()` so a blocked
   * `fetchRecent` returns immediately with no leaked timer — the same teardown discipline the
   * listener connection gets.
   */
  protected readonly pendingAborts = new Set<() => void>();

  protected require(): Pool {
    if (this.pool !== undefined) return this.pool;
    throw new Error('PostgresPlugin not connected — call connect() first');
  }

  protected readSince(topic: Topic, since: string, limit: number): Promise<MessageRow[]> {
    return messagesSince(this.require(), this.names, topic, since, limit);
  }
}
