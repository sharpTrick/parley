/**
 * Presence emitter (DESIGN §7/§9, presence). A proactive loop — a sibling of the push loop —
 * that announces THIS bridge on ONE shared presence topic: a `hello` on start, a `heartbeat` on
 * an interval, and a best-effort `goodbye` on clean shutdown. Each beat carries the bridge's
 * subscribed topics AND its `post_topics` reach (the regex sources it may post to) so
 * `parley_list_users` can report liveness per topic and match hand-off partners in either
 * direction.
 *
 * Writes go through the seam's single `post` path, to the configured presence topic — so this
 * adds no new allowlist surface and no seam method. The roster is reconstructed on demand by
 * `parley_list_users` (see engine/presence.ts).
 */
import type { Allowlist } from '../allowlist.js';
import type { Handle, Topic } from '../message.js';
import type { BackendPlugin } from '../seam.js';
import { encodePresence, type PresenceKind } from '../engine/presence.js';

export interface PresenceLoopOptions {
  /** The shared presence topic to announce on (`presence.topic`). */
  presenceTopic: Topic;
  /** Heartbeat cadence (ms). */
  heartbeatMs: number;
  /** Clock source; injectable for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

/** A running presence loop. Call {@link stop} once to cancel the timer and say goodbye. */
export interface PresenceLoop {
  stop(): Promise<void>;
}

/**
 * Start announcing presence. Posts `hello` immediately, then `heartbeat` every `heartbeatMs`.
 * Emission is best-effort: a failed beat is swallowed (the roster is advisory and reconciled by
 * the TTL window), so a transient backend hiccup never crashes the bridge.
 */
export function startPresenceLoop(
  plugin: BackendPlugin,
  identity: Handle,
  allow: Allowlist,
  opts: PresenceLoopOptions,
): PresenceLoop {
  const now = opts.now ?? Date.now;
  // Subscribed topics and post_topics reach are both static config — capture once and advertise
  // them on every beat. `postTopics` are the raw pattern SOURCES (peers compile them defensively).
  const subscribedTopics = allow.topics();
  const postTopics = allow.patterns();

  const beat = async (kind: PresenceKind): Promise<void> => {
    const content = encodePresence({
      v: 2,
      kind,
      at: now(),
      topics: subscribedTopics,
      postTopics,
    });
    await plugin.post(opts.presenceTopic, identity, content).catch(() => {
      // Best-effort: a dropped beat is harmless; TTL reconciles (engine/presence.ts).
    });
  };

  void beat('hello');
  const timer = setInterval(() => void beat('heartbeat'), heartbeatClamp(opts.heartbeatMs));
  // Don't keep the process alive solely for heartbeats.
  timer.unref?.();

  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await beat('goodbye');
    },
  };
}

/** setInterval treats <=0 as 0 and floors to ~1ms; guard against a misconfigured cadence. */
function heartbeatClamp(ms: number): number {
  return ms > 0 ? ms : 1;
}
