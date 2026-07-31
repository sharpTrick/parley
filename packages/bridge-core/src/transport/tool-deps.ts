import { allowlistFor, type Allowlist } from '../allowlist.js';
import type { ParleyConfig } from '../config.js';
import type { SeenSet } from '../engine/seen-set.js';
import { asHandle, asTopic, type Handle, type Topic } from '../message.js';
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
  /** The shared presence topic `parley_list_users` reads (`presence.topic`). */
  presenceTopic: Topic;
  /** Liveness window (ms) for `parley_list_users` — a handle is live if its last beat is within it. */
  presenceTtlMs: number;
  /** Server-side cap (ms) on `parley_fetch_recent`'s `block_ms` long-poll. */
  blockMaxMs: number;
  /** Poll cadence (ms) for core's generic long-poll fallback. */
  blockPollIntervalMs: number;
  /** Clock source; injectable for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * The single place both composition roots (stdio bridge + remote HTTP) derive {@link ToolDeps} from
 * config, so a new tool dependency is a one-file change instead of a lockstep edit across both
 * roots.
 */
export function toolDepsFor(
  plugin: BackendPlugin,
  cfg: ParleyConfig,
  extras?: { seen?: SeenSet },
): ToolDeps {
  return {
    plugin,
    identity: asHandle(cfg.identity.handle),
    allow: allowlistFor(cfg),
    presenceTopic: asTopic(cfg.presence.topic),
    presenceTtlMs: cfg.presence.ttl_ms,
    blockMaxMs: cfg.catchup.block_max_ms,
    blockPollIntervalMs: cfg.catchup.block_poll_interval_ms,
    seen: extras?.seen,
  };
}
