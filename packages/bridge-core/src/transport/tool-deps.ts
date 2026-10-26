import { allowlistFor, type Allowlist } from '../allowlist.js';
import type { ParleyConfig } from '../config.js';
import { LiveDeliveryLedger, liveDeliveryBlockers } from '../engine/live-delivery.js';
import type { ReadStateStore } from '../engine/read-state.js';
import type { SeenSet } from '../engine/seen-set.js';
import { asHandle, type Handle } from '../message.js';
import type { BackendPlugin } from '../seam.js';

/** Dependencies the reactive/reply tools close over. */
export interface ToolDeps {
  plugin: BackendPlugin;
  /** This instance's handle — the identity all posts are written as. */
  identity: Handle;
  allow: Allowlist;
  /**
   * Push-loop dedup set, shared with the live `fetch_recent` tool. Only the stdio bridge (which owns
   * the push loop) supplies it; the reactive HTTP path has no push loop, so it is optional.
   */
  seen?: SeenSet;
  /**
   * Where this instance has read to, per topic. `parley_fetch_recent` resumes from it when the
   * caller passes no `since`, and advances it on the way out — which is what makes "catch up on
   * session start" reach everything a session missed while it was down instead of the newest page
   * of it.
   *
   * Only the stdio bridge supplies it. The remote HTTP root is stateless and shares one `deps`
   * across every chat client on the port, so one position there would be several sessions' at once;
   * absent, a since-less read answers with the backend's recent window, as every read there did
   * before.
   *
   * Narrowed to the two calls the tool makes, so a test double is a position rather than a file.
   */
  readState?: Pick<ReadStateStore, 'get' | 'set'>;
  /** Server-side cap (ms) on `parley_fetch_recent`'s `block_ms` long-poll. */
  blockMaxMs: number;
  /** Poll cadence (ms) at which core re-drives a plugin that came back early from a budget. */
  blockPollIntervalMs: number;
  /**
   * Run-time enforcer for the seam's live-delivery clause, shared with the push loop that feeds its
   * other half. `parley_live_status` reads it; both roots supply one, and the one built where the
   * counters cannot be compared refuses to answer rather than reporting health.
   */
  live: LiveDeliveryLedger;
}

/**
 * The single place both composition roots (stdio bridge + remote HTTP) derive {@link ToolDeps} from
 * config, so a new tool dependency is a one-file change instead of a lockstep edit across both
 * roots.
 */
export function toolDepsFor(
  plugin: BackendPlugin,
  cfg: ParleyConfig,
  extras?: { seen?: SeenSet; readState?: ToolDeps['readState'] },
): ToolDeps {
  const allow = allowlistFor(cfg);
  return {
    plugin,
    identity: asHandle(cfg.identity.handle),
    allow,
    blockMaxMs: cfg.catchup.block_max_ms,
    blockPollIntervalMs: cfg.catchup.block_poll_interval_ms,
    seen: extras?.seen,
    readState: extras?.readState,
    live: new LiveDeliveryLedger(
      allow.topics(),
      liveDeliveryBlockers({
        livePushEnabled: cfg.live_push.enabled,
        startCatchUp: cfg.catchup.on_start,
        dedupWindow: extras?.seen !== undefined,
      }),
    ),
  };
}
