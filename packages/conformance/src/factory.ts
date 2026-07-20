import type { BackendPlugin, Topic } from '@sharptrick/parley-core';

/**
 * What a backend provides so the shared suite can run against it. Written ONCE against the
 * seam; every backend (sqlite now; redis/matrix/xmpp/nats later) supplies a factory.
 */
export interface ConformanceContext {
  /** A freshly connected plugin instance. */
  plugin: BackendPlugin;
  /** A unique, unused topic — isolates each test from the others. */
  freshTopic(): Topic;
  /** Disconnect + remove any scratch resources. */
  cleanup(): Promise<void>;
  /**
   * Optional: drive `writers` independent concurrent writers, each posting `perWriter`
   * messages to `topic`, to prove concurrent-write safety. For SQLite this forks real OS
   * processes (WAL + busy_timeout); network backends use N client connections. Omit if a
   * backend can't exercise true concurrency in tests.
   */
  concurrentPost?(topic: Topic, writers: number, perWriter: number): Promise<void>;
  /**
   * Set by backends that honor `blockMs` NATIVELY in `fetchRecent` (Redis XREAD BLOCK, NATS pull
   * expiry, Matrix `/sync` timeout, XMPP MUC wait, Postgres LISTEN/NOTIFY, …). When true, the
   * shared blocking-fetch case runs directly against the plugin; when unset it is skipped, because
   * that backend gets its long-poll from core's generic wrapper (tested in bridge-core), not the
   * plugin (issue #20). SQLite is polling-only and leaves this unset.
   */
  supportsBlockingFetch?: boolean;
}

export type BackendFactory = () => Promise<ConformanceContext>;
