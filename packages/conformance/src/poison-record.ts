import { expect } from 'vitest';

/**
 * Inbound is untrusted (CLAUDE.md), and every backend's live path converts a wire record into a
 * {@link Message} before it can hand one to the handler. A record the plugin's OWN converter chokes
 * on therefore has to be contained the same way a handler's throw is: it costs that one record.
 * When it is not, the throw escapes into whatever the live path wraps its batch in, and the records
 * BEHIND the poison one go with it — a loop that has already advanced its watermark drops them for
 * good, and one that has not re-reads them behind a subscription it has meanwhile faulted.
 *
 * Backend-supplied rather than driven from a shared corpus: a poison record is whatever the
 * backend's own store or wire admits and its own converter refuses, which nothing here can know.
 */
export interface PoisonedBatch {
  /** Content of the records that MUST reach the handler, in delivery order. */
  readonly survivors: readonly string[];
  /** Put `survivors[0]`, a record this backend's converter chokes on, then the rest on the live path. */
  plant(): Promise<void> | void;
  /** Let the live path carry what `plant` left, and resolve once it has had its chance to. */
  settle(): Promise<void>;
  /** What the handler received, in order. */
  delivered(): readonly string[];
  /** A backend that publishes subscription health, paired with what it must still report. */
  readonly stillHealthy?: { report(): unknown; expected: unknown };
}

/** Names the clause, so a failure in any backend's suite locates itself as this one. */
export const POISON_RECORD_CLAUSE = 'an unconvertible record costs one message, not the batch';

export async function expectPoisonCostsOneMessage(batch: PoisonedBatch): Promise<void> {
  await batch.plant();
  await batch.settle();
  expect(batch.delivered()).toEqual(batch.survivors);
  const health = batch.stillHealthy;
  if (health !== undefined) expect(health.report()).toEqual(health.expected);
}
