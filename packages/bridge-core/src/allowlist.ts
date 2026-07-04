import type { ParleyConfig } from './config.js';
import { asTopic, type Topic } from './message.js';

/** Raised when a tool call or subscription targets a topic outside the allowlist. */
export class TopicNotAllowedError extends Error {
  constructor(public readonly topic: string) {
    super(`topic not allowed: ${JSON.stringify(topic)}`);
    this.name = 'TopicNotAllowedError';
  }
}

/** Options extending the exact allowlist with a post/fetch pattern dimension and reserved topics. */
export interface AllowlistOptions {
  /**
   * Regex sources additionally allowed for `post`/`fetch_recent` (NOT subscribe/catch-up).
   * Each is compiled full-match anchored (`^(?:src)$`). Invalid sources should be rejected by
   * config validation first; the constructor throws if one reaches here.
   */
  postPatterns?: readonly string[];
  /** Topics never allowed via ANY path, even if matched by a pattern (the presence topic). */
  reserved?: readonly string[];
}

/**
 * The topic allowlist (DESIGN §14). Two dimensions:
 *
 *  - the EXPLICIT list (`config.topics`) — the only set `subscribe`/catch-up iterate and the
 *    default scope of `parley_list_users`; exposed via {@link topics};
 *  - the POST/FETCH set — the explicit list PLUS any `post_topics` pattern match; gates
 *    `post`/`reply`/`fetch_recent` via {@link has}/{@link assert}.
 *
 * There is no wildcard-everything default: patterns are opt-in and never widen subscribe. A
 * `reserved` topic (the presence topic) is refused on BOTH dimensions — a broad pattern can
 * never make it postable/fetchable, so a peer cannot spoof the presence roster.
 *
 * Inbound is untrusted (DESIGN §14): message content becomes agent context and is never treated
 * as a privileged instruction. A reply always targets the inbound topic, which is subscribed
 * (thus in the explicit list) and therefore already allowed.
 */
export class Allowlist {
  private readonly allowed: Set<string>;
  private readonly reserved: Set<string>;
  private readonly patternSources: readonly string[];
  private readonly patternRegexes: RegExp[];

  constructor(topics: Iterable<string>, opts: AllowlistOptions = {}) {
    this.allowed = new Set(topics);
    this.reserved = new Set(opts.reserved ?? []);
    for (const t of this.allowed) {
      if (this.reserved.has(t)) throw new TopicNotAllowedError(t); // reserved ∩ explicit is a config error
    }
    this.patternSources = opts.postPatterns ?? [];
    this.patternRegexes = this.patternSources.map((src) => new RegExp(`^(?:${src})$`));
  }

  /** True if the topic may be posted to / fetched: explicit OR pattern match, never reserved. */
  has(topic: string): boolean {
    if (this.reserved.has(topic)) return false;
    if (this.allowed.has(topic)) return true;
    return this.patternRegexes.some((re) => re.test(topic));
  }

  /** Return the branded Topic if postable/fetchable; otherwise throw {@link TopicNotAllowedError}. */
  assert(topic: string): Topic {
    if (!this.has(topic)) throw new TopicNotAllowedError(topic);
    return asTopic(topic);
  }

  /** The EXPLICIT topics only, branded — what subscribe/catch-up/presence iterate. */
  topics(): Topic[] {
    return [...this.allowed].map(asTopic);
  }

  /** The raw `post_topics` pattern sources (for surfacing in tool descriptions). */
  patterns(): string[] {
    return [...this.patternSources];
  }
}

/**
 * Build the Allowlist a bridge runs with: the explicit `topics`, extended for post/fetch by the
 * `post_topics` patterns, with the presence topic reserved so no pattern can spoof the roster.
 * Single source of truth shared by every composition root (stdio + remote HTTP).
 */
export function allowlistFor(cfg: ParleyConfig): Allowlist {
  return new Allowlist(cfg.topics, {
    postPatterns: cfg.post_topics,
    reserved: [cfg.presence.topic],
  });
}
