import type { Topic } from '@sharptrick/parley-core';
import type { Client, Pool } from 'pg';
import { DEFAULT_TABLE_NAME, DEFAULT_URL } from './config.js';
import type { ListenState } from './listen.js';
import type { TopicSubscription } from './push.js';
import { messagesSince } from './read.js';
import { type MessageRow, quotedNames, type SchemaNames } from './schema.js';

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
   * waits on. The notification handler fans a NOTIFY out to every registered wake.
   */
  protected readonly waiters = new Map<string, Set<() => void>>();
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
