import type { BackendPlugin, Topic } from '@parley/core';

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
}

export type BackendFactory = () => Promise<ConformanceContext>;
