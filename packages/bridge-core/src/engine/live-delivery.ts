import type { Topic } from '../message.js';

/**
 * What this bridge has observed about one topic's live path since the subscription was armed.
 * `not-delivering` is the alarm: every message the agent has been handed on that topic arrived
 * through the reconciling read and none through push, which is what a plugin that registered no
 * listener looks like from above the seam (seam.ts clause 3 — "one whose live path delivers nothing
 * at all is not [conformant]").
 */
export type LiveDeliveryStatus = 'delivering' | 'not-delivering' | 'no-traffic';

export interface TopicLiveDelivery {
  topic: Topic;
  status: LiveDeliveryStatus;
  /** Messages this topic's push handler accepted (past the trust check and the dedup gate). */
  pushed: number;
  /** Messages `parley_fetch_recent` handed the agent that push had not already delivered. */
  reconciled: number;
}

/**
 * Why a bridge cannot tell a dead live path from a healthy one. Each is a configuration in which the
 * two counters mean nothing, and reporting `delivering`/`no-traffic` from them would be an answer
 * this bridge has no way to stand behind.
 */
export const LIVE_DELIVERY_BLOCKERS = {
  push_disabled:
    'live_push.enabled is false: this bridge arms no live subscription at all, so a push path ' +
    'that delivers nothing is indistinguishable from one that was never asked to deliver.',
  no_dedup_window:
    'this bridge keeps no dedup window, so a message the agent read through catch-up cannot be ' +
    'told from one live push had already delivered. The stateless remote HTTP root is this ' +
    'configuration, and it runs no push loop either.',
  no_start_catchup:
    'catchup.on_start is false, so the backlog that predates the subscription reaches the agent ' +
    'through catch-up unseen, and reads exactly like a live path that missed it.',
} as const;

export type LiveDeliveryBlocker = keyof typeof LIVE_DELIVERY_BLOCKERS;

export type LiveDeliveryReport =
  | { decided: true; topics: TopicLiveDelivery[] }
  | { decided: false; blockedBy: Array<{ reason: LiveDeliveryBlocker; detail: string }> };

/** The configuration facts that decide whether the counters mean anything. */
export interface LiveDeliveryPreconditions {
  livePushEnabled: boolean;
  startCatchUp: boolean;
  dedupWindow: boolean;
}

export function liveDeliveryBlockers(p: LiveDeliveryPreconditions): LiveDeliveryBlocker[] {
  const blockers: LiveDeliveryBlocker[] = [];
  if (!p.livePushEnabled) blockers.push('push_disabled');
  if (!p.dedupWindow) blockers.push('no_dedup_window');
  if (!p.startCatchUp) blockers.push('no_start_catchup');
  return blockers;
}

/**
 * Run-time enforcer for the seam's third clause: push delivers a SUBSET of the post-subscribe tail,
 * and a subset may be small but may not be empty. The CI half of that clause is the conformance
 * suite; this is the half a deployment has, where a plugin whose `subscribe` silently registers
 * nothing leaves the agent reading everything through `parley_fetch_recent` and no error anywhere.
 *
 * Keyed on the allowlist's subscribed topics, so the map is bounded by configuration rather than by
 * plugin-supplied strings; an increment for anything else is dropped.
 *
 * REFUSES to answer when it was built somewhere the two counters cannot be compared. An enforcer
 * that reported `no-traffic` there would be certifying a path it never observed.
 */
export class LiveDeliveryLedger {
  private readonly counts = new Map<Topic, { pushed: number; reconciled: number }>();

  constructor(
    topics: readonly Topic[],
    private readonly blockers: readonly LiveDeliveryBlocker[] = [],
  ) {
    for (const topic of topics) this.counts.set(topic, { pushed: 0, reconciled: 0 });
  }

  recordPush(topic: Topic): void {
    const count = this.counts.get(topic);
    if (count !== undefined) count.pushed++;
  }

  recordReconciled(topic: Topic): void {
    const count = this.counts.get(topic);
    if (count !== undefined) count.reconciled++;
  }

  report(): LiveDeliveryReport {
    if (this.blockers.length > 0) {
      return {
        decided: false,
        blockedBy: this.blockers.map((reason) => ({
          reason,
          detail: LIVE_DELIVERY_BLOCKERS[reason],
        })),
      };
    }
    return {
      decided: true,
      topics: [...this.counts].map(([topic, count]) => ({
        topic,
        status: statusOf(count),
        ...count,
      })),
    };
  }
}

function statusOf(count: { pushed: number; reconciled: number }): LiveDeliveryStatus {
  if (count.pushed > 0) return 'delivering';
  return count.reconciled > 0 ? 'not-delivering' : 'no-traffic';
}
