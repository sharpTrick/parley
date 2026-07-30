/**
 * The one fixture every file in this suite builds on: start an in-process fake workspace, connect a
 * plugin to it, and tear both down. Restating it per file made a constructor option (`handshake_
 * timeout_ms`) reach two of six harnesses, so files silently ran on different timeouts — a
 * divergence no test could report. Everything a file legitimately varies is a named option here, so
 * the axis a given file exercises is visible next to the rows that exercise it.
 */
import { asTopic, type Topic } from '@sharptrick/parley-core';
import { DIAL_BACKOFF_MS, MAX_DIAL_BACKOFF_MS, SlackPlugin } from '../src/index.js';
import { FakeSlack, type GreetMode } from './fake-slack.js';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface SlackHarnessOptions {
  /** `null` configures NO app_token — the legal reactive-only deployment, not a fault. */
  appToken?: string | null;
  mentionMap?: Record<string, string>;
  channelMap?: Record<string, string>;
  /** Omitted by default, so the plugin's own DEFAULT_HANDSHAKE_TIMEOUT_MS applies. */
  handshakeTimeoutMs?: number;
  /** `conversations.history` objects per page — the tier cap, which the caller cannot raise. */
  pageSize?: number;
  greet?: GreetMode;
  /** Channel ids to create in the fake before connecting. */
  channels?: string[];
  /** Anything else to set on the fake before the plugin connects (latency, injected failures, …). */
  arm?: (fake: FakeSlack) => void;
}

export interface SlackHarness {
  fake: FakeSlack;
  plugin: SlackPlugin;
  cleanup: () => Promise<void>;
}

export async function startSlack(opts: SlackHarnessOptions = {}): Promise<SlackHarness> {
  const fake = await FakeSlack.start(opts.pageSize === undefined ? undefined : { pageSize: opts.pageSize });
  if (opts.greet !== undefined) fake.setGreet(opts.greet);
  for (const channel of opts.channels ?? []) fake.createChannel(channel);
  opts.arm?.(fake);
  const plugin = new SlackPlugin();
  await plugin.connect({
    api_url: fake.apiUrl,
    bot_token: 'xoxb-test',
    ...(opts.appToken === null ? {} : { app_token: opts.appToken ?? 'xapp-test' }),
    ...(opts.mentionMap === undefined ? {} : { mention_map: opts.mentionMap }),
    ...(opts.channelMap === undefined ? {} : { channel_map: opts.channelMap }),
    ...(opts.handshakeTimeoutMs === undefined
      ? {}
      : { handshake_timeout_ms: opts.handshakeTimeoutMs }),
  });
  return {
    fake,
    plugin,
    cleanup: async () => {
      await plugin.disconnect();
      await fake.close();
    },
  };
}

export async function withSlack<T>(
  opts: SlackHarnessOptions,
  fn: (fake: FakeSlack, plugin: SlackPlugin) => Promise<T>,
): Promise<T> {
  const { fake, plugin, cleanup } = await startSlack(opts);
  try {
    return await fn(fake, plugin);
  } finally {
    await cleanup();
  }
}

/** Land a message in history AND on the live socket, exactly as a real workspace write would. */
export function deliver(fake: FakeSlack, topic: Topic | string, text: string): void {
  const channel = typeof topic === 'string' ? asTopic(topic) : topic;
  const [created] = fake.seed(channel, [{ text }]);
  fake.pushEvent(channel, { ts: created!.ts, text, user: 'U0PARLEY' });
}

export type Settled<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'pending' };

/**
 * Attach the outcome handlers to `p` NOW — a call that rejects before the test gets round to
 * awaiting it is an unhandled rejection, which vitest reports as a run-level error rather than a
 * row failure — and report which way it went, or `pending`, once `ms` has passed. A test that
 * simply awaits the call cannot fail on a call that never settles: it hangs.
 */
export function capture<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value): Settled<T> => ({ status: 'fulfilled', value }),
    (reason: unknown): Settled<T> => ({ status: 'rejected', reason }),
  );
}

export async function settleWithin<T>(
  captured: Promise<Settled<T>>,
  ms: number,
): Promise<Settled<T>> {
  const pending: Settled<T> = { status: 'pending' };
  return Promise.race([captured, sleep(ms).then(() => pending)]);
}

/**
 * The degradation ladder a blocked `fetchRecent` re-reads history on, derived from the plugin's OWN
 * exported constants rather than restated: rung starts, in ms from the moment the block began. Both
 * the latency grading in `blocking-fetch.test.ts` and the README's cost claim are computed from
 * this, so a reshaped ladder moves the tests and the prose together.
 */
export function rungStarts(blockMs: number): number[] {
  const starts = [0];
  let at = 0;
  let width = DIAL_BACKOFF_MS;
  while (at < blockMs) {
    at += width;
    starts.push(at);
    width = Math.min(width * 2, MAX_DIAL_BACKOFF_MS);
  }
  return starts;
}
