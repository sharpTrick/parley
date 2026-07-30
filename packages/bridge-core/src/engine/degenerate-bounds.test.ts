import { describe, expect, it } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { asHandle, asTopic } from '../message.js';
import { FakePlugin } from '../testing/fake-plugin.js';
import { startPresenceLoop, type PresenceLoop } from '../transport/presence-loop.js';
import { fetchRecentBlocking } from './blocking-fetch.js';
import { SEEN_MAX_PER_TOPIC, SEEN_MAX_TOPICS, SeenSet } from './seen-set.js';

/**
 * Core's sizing knobs are all embedder-facing: `new SeenSet(a, b)`, `fetchRecentBlocking`'s poll
 * budget, `startPresenceLoop`'s cadence. Wire any of them from a mis-set config and a degenerate
 * value does not shrink the feature, it DELETES it — a zero dedup window re-emits every message as a
 * `<channel>` event forever, a zero poll interval turns a long poll into a single fetch, a sub-1 ms
 * cadence turns a heartbeat into a post storm — and it does so with no error and no log. Fail fast
 * instead. Table every such knob against the values that would degrade it, and pair each with the
 * legal value it must still accept, so "reject everything" is not a passing answer.
 */
interface Knob {
  label: string;
  /** Build the feature with `value` in this knob. Must reject for a degenerate value. */
  build: (value: number) => unknown;
  /** Values whose acceptance silently turns this feature off or perverts it. */
  degenerate: number[];
  /** A value this knob must still accept — the control against an over-strict guard. */
  legal: number;
  cleanup?: (made: unknown) => Promise<void>;
}

const presenceDeps = () => ({
  plugin: new FakePlugin(),
  identity: asHandle('agent'),
  allow: new Allowlist(['ctx']),
  presenceTopic: asTopic('parley-presence'),
});

const KNOBS: Knob[] = [
  {
    label: 'SeenSet maxPerTopic',
    build: (maxPerTopic) => new SeenSet(maxPerTopic, SEEN_MAX_TOPICS),
    degenerate: [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    legal: SEEN_MAX_PER_TOPIC,
  },
  {
    label: 'SeenSet maxTopics',
    build: (maxTopics) => new SeenSet(SEEN_MAX_PER_TOPIC, maxTopics),
    degenerate: [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    legal: SEEN_MAX_TOPICS,
  },
  {
    label: 'fetchRecentBlocking pollIntervalMs',
    build: (pollIntervalMs) =>
      fetchRecentBlocking(new FakePlugin(), { topic: asTopic('ctx') }, { blockMs: 0, pollIntervalMs }),
    degenerate: [0, -1, Number.NaN, Number.NEGATIVE_INFINITY],
    legal: 250,
  },
  {
    label: 'fetchRecentBlocking blockMs',
    build: (blockMs) =>
      fetchRecentBlocking(new FakePlugin(), { topic: asTopic('ctx') }, { blockMs, pollIntervalMs: 250 }),
    degenerate: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    legal: 0,
  },
  {
    label: 'startPresenceLoop heartbeatMs',
    build: (heartbeatMs) => {
      const { plugin, identity, allow, presenceTopic } = presenceDeps();
      return startPresenceLoop(plugin, identity, allow, { presenceTopic, heartbeatMs });
    },
    degenerate: [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ],
    legal: 600_000,
    cleanup: (made) => (made as PresenceLoop).stop(),
  },
];

/** Run `build` so a synchronous throw and a rejected promise are the same observable failure. */
const attempt = async (knob: Knob, value: number): Promise<unknown> => knob.build(value);

describe('a degenerate bound is refused, never silently applied', () => {
  const CELLS = KNOBS.flatMap((knob) => knob.degenerate.map((value) => [knob.label, value, knob] as const));

  it.each(CELLS)('%s = %s is a RangeError', async (_label, value, knob) => {
    await expect(attempt(knob, value)).rejects.toBeInstanceOf(RangeError);
  });

  it.each(KNOBS.map((knob) => [knob.label, knob] as const))(
    '%s still accepts its production value',
    async (_label, knob) => {
      const made = await attempt(knob, knob.legal);
      expect(made).toBeDefined();
      await knob.cleanup?.(made);
    },
  );
});
