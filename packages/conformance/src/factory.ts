import type { BackendPlugin, Topic } from '@sharptrick/parley-core';
import { CONTENT_SHAPES } from './cases/content.js';

/**
 * What a backend provides so the shared suite can run against it. Written ONCE against the seam;
 * every backend supplies a factory.
 *
 * The capability fields are REQUIRED and take an explicit negative, so that a backend which simply
 * forgot one loses a compile rather than a test case. An optional flag whose absent value means
 * "skip" silently trades coverage for convenience.
 *
 * Whether `fetchRecent` honours `blockMs` is deliberately NOT a field here, nor anywhere else: the
 * suite decides it from what the backend DOES with a budget — park, or refuse — so there is no
 * declaration a backend can flip while the suite goes on grading the arm it used to take.
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
   * True when the backend round-trips the `identity` argument of `post` as the message's
   * `senderHandle`. False for backends that stamp the authenticated account instead: every hosted
   * SaaS posts as its bot user, and Matrix reports the homeserver-stamped `sender`. On those the
   * `identity` argument is informational, and asserting it would be asserting a lie.
   */
  carriesSenderIdentity: boolean;
  /**
   * Which labels from `CONTENT_SHAPES` this backend REFUSES on `post`. Refusing a payload is an arm
   * the write clause permits — but it is an arm, and an arm has to be STATED: a refusal also
   * shortens what the live floor can carry, and while the floor silently fell back to a bare token
   * on a rejection, a backend that refused every shape on `post` and dropped every long, non-ASCII
   * or control-carrying message on the live path was certified 36 of 36 — the identical measurement
   * recorded for the defect that fallback was added to fix.
   *
   * Declared, so it cannot be a silent trade: a label here MUST really be refused (the write clause
   * asserts the rejection), a label absent from it MUST round-trip exactly and MUST reach a live
   * subscriber, and the live floor records which shapes it actually carried and grades that against
   * this list. Every backend here states `[]` but Zulip, whose server strips a body's trailing
   * whitespace on send and whose `post` therefore refuses that shape rather than storing something
   * else — a trade that was being made silently until it had to be declared.
   */
  refusesContentShapes: readonly string[];
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
  carriesSenderIdentity: (v) => typeof v === 'boolean',
  refusesContentShapes: (v) =>
    Array.isArray(v) && v.every((label) => CONTENT_SHAPES.some(([known]) => known === label)),
  absentTopicBehaviour: (v) => v === undefined || v === 'empty-page' || v === 'throws',
};

/**
 * The fields that select a fixture ARM rather than supplying the fixture itself. A case that reads
 * one of these is branching on what the backend can represent, and the branch it takes has to grade
 * something — see the guarded-region check in `runConformanceSuite`.
 */
export const CAPABILITY_FIELDS: string[] = Object.keys(CONTEXT_FIELDS).filter(
  (f) => !['plugin', 'freshTopic', 'cleanup'].includes(f),
);

/**
 * Build a fixture and validate it, disconnecting again if it turns out to be malformed. Keep the
 * teardown on the RAW fixture, so that a context rejected for one bad capability flag is still torn
 * down: the factory has already CONNECTED the plugin by the time it returns, and a validator that
 * throws on the way out otherwise strands a live socket and poll loop per case — which is how a run
 * hangs instead of failing cleanly.
 */
export async function openContext(
  name: string,
  factory: BackendFactory,
): Promise<ConformanceContext> {
  const raw: unknown = await factory();
  try {
    return assertConformanceContext(name, raw);
  } catch (err) {
    const cleanup = (raw as Partial<ConformanceContext> | null | undefined)?.cleanup;
    if (typeof cleanup === 'function') await cleanup.call(raw).catch(() => undefined);
    throw err;
  }
}

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
