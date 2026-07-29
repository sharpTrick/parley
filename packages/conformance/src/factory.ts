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
  /**
   * Which arm of `fetchRecent`'s absent-topic contract the backend takes: an empty page with a
   * replayable cursor, or a `NoSuchTopicError` rejection. seam.ts permits BOTH, and core has a
   * whole module mapping the second to "topic not present yet".
   *
   * The one optional field here, and only because its default — `'empty-page'` — is the STRICTER
   * arm: omitting it cannot buy a weaker grade. That is exactly what an omitted capability flag
   * does everywhere else, which is why every other field is required.
   */
  absentTopicBehaviour?: 'empty-page' | 'throws';
}

export type BackendFactory = () => Promise<ConformanceContext>;

/**
 * The shape check behind the "REQUIRED" above. `tsconfig.json` covers only `src/**`, and vitest
 * transpiles without typechecking, so no backend's context is ever seen by a compiler — a dropped
 * capability field silently deletes the cases that read it instead of losing a build. Keep this
 * runtime check, so that the requirement is enforced somewhere.
 */
export const CONTEXT_FIELDS: Record<keyof ConformanceContext, (v: unknown) => boolean> = {
  plugin: (v) => typeof v === 'object' && v !== null,
  freshTopic: (v) => typeof v === 'function',
  cleanup: (v) => typeof v === 'function',
  concurrentPost: (v) => typeof v === 'function' || v === 'unsupported',
  supportsBlockingFetch: (v) => typeof v === 'boolean',
  carriesSenderIdentity: (v) => typeof v === 'boolean',
  absentTopicBehaviour: (v) => v === undefined || v === 'empty-page' || v === 'throws',
};

/** Throws naming the backend and the offending field; returns the context so it can be inlined. */
export function assertConformanceContext(name: string, ctx: unknown): ConformanceContext {
  if (typeof ctx !== 'object' || ctx === null) {
    throw new Error(`conformance context for ${name} is not an object`);
  }
  const record = ctx as Record<string, unknown>;
  for (const [field, ok] of Object.entries(CONTEXT_FIELDS)) {
    if (!ok(record[field])) {
      throw new Error(
        `conformance context for ${name} has an invalid \`${field}\`: ` +
          `${JSON.stringify(record[field]) ?? typeof record[field]}. Every field of ` +
          `ConformanceContext is required — an omitted one silently skips the cases that read it.`,
      );
    }
  }
  return ctx as ConformanceContext;
}
