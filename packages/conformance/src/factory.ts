import type { BackendPlugin, Topic } from '@sharptrick/parley-core';

/**
 * What a backend provides so the shared suite can run against it. Written ONCE against the seam;
 * every backend supplies a factory.
 *
 * The capability fields are REQUIRED and take an explicit negative, so that a backend which simply
 * forgot one loses a compile rather than a test case. An optional flag whose absent value means
 * "skip" silently trades coverage for convenience, which is how the blocking-fetch case went
 * unexercised on backends that do implement it.
 */
export interface ConformanceContext {
  /** A freshly connected plugin instance. */
  plugin: BackendPlugin;
  /** A unique, unused topic — isolates each test from the others. */
  freshTopic(): Topic;
  /** Disconnect + remove any scratch resources. */
  cleanup(): Promise<void>;
  /**
   * Drive `writers` independent concurrent writers, each posting `perWriter` messages to `topic`,
   * to prove concurrent-write safety. For SQLite this forks real OS processes (WAL +
   * busy_timeout); network backends use N client connections. `'unsupported'` states that the
   * backend cannot represent concurrent writers at all — Telegram allows one `getUpdates` consumer
   * per token, so a second poller gets HTTP 409.
   */
  concurrentPost: ((topic: Topic, writers: number, perWriter: number) => Promise<void>) | 'unsupported';
  /**
   * True for backends that honor `blockMs` NATIVELY in `fetchRecent` (Redis `XREAD BLOCK`, NATS
   * pull expiry, Matrix `/sync` timeout, XMPP MUC wait, Postgres `LISTEN`/`NOTIFY`, …). False for a
   * polling-only backend that gets its long-poll from core's generic wrapper instead — SQLite.
   */
  supportsBlockingFetch: boolean;
  /**
   * True when the backend round-trips the `identity` argument of `post` as the message's
   * `senderHandle`. False for backends that stamp the authenticated account instead: every hosted
   * SaaS posts as its bot user, and Matrix reports the homeserver-stamped `sender`. On those the
   * `identity` argument is informational, and asserting it would be asserting a lie.
   */
  carriesSenderIdentity: boolean;
}

export type BackendFactory = () => Promise<ConformanceContext>;
