import { MAX_POST_TOPICS, type ParleyConfig } from './config.js';
import { asTopic, type Topic } from './message.js';
import { isRedosSafeSource, MAX_MATCH_INPUT } from './regex-safety.js';

/** Raised when a tool call or subscription targets a topic outside the allowlist. */
export class TopicNotAllowedError extends Error {
  constructor(
    public readonly topic: string,
    reason?: string,
  ) {
    super(
      reason === undefined
        ? `topic not allowed: ${JSON.stringify(topic)}`
        : `topic not allowed: ${JSON.stringify(topic)} — ${reason}`,
    );
    this.name = 'TopicNotAllowedError';
  }
}

const EMPTY_TOPIC_REASON =
  'a topic names a channel, so it can never be the empty string (the config loader refuses one too)';

/** Raised when a `post_topics` pattern could be driven into catastrophic backtracking. */
export class UnsafePatternError extends Error {
  constructor(public readonly pattern: string) {
    super(
      `post pattern risks catastrophic backtracking: ${JSON.stringify(pattern)} — a ` +
        'caller-supplied topic could hang the bridge. Simplify it (see post_topics in the README).',
    );
    this.name = 'UnsafePatternError';
  }
}

/**
 * Compile the source on its own before it is wrapped in `^(?:…)$`. Keep this check, so that an
 * unbalanced source — uncompilable alone, yet legal once wrapped, where the anchors re-associate
 * into one branch of an unanchored alternation — throws instead of minting an allow-everything set.
 */
function assertCompilesAlone(src: string): void {
  new RegExp(src);
}

/** Options extending the exact allowlist with a post/fetch pattern dimension and reserved topics. */
export interface AllowlistOptions {
  /**
   * Regex sources additionally allowed for `post`/`fetch_recent` (NOT subscribe/catch-up).
   * Each is compiled full-match anchored (`^(?:src)$`) and screened for catastrophic backtracking,
   * and the collection is capped at {@link MAX_POST_TOPICS} — the screen bounds what ONE source can
   * spend, and {@link has} runs every one of them against the same caller-supplied topic. Config
   * validation rejects all three classes first; the constructor throws if one reaches here —
   * `SyntaxError` for an uncompilable source, {@link UnsafePatternError} for an unsafe one, and a
   * `RangeError` for too many.
   */
  postPatterns?: readonly string[];
  /** Topics never allowed via ANY path, even if matched by a pattern (the presence topic). */
  reserved?: readonly string[];
}

/**
 * The topic allowlist (DESIGN §14). Two dimensions:
 *
 *  - the EXPLICIT list (`config.topics`) — the only set `subscribe`/catch-up iterate, and the set a
 *    peer must reach for us to count it INBOUND-reachable; exposed via {@link topics};
 *  - the POST/FETCH set — the explicit list PLUS any `post_topics` pattern match; gates
 *    `post`/`reply`/`fetch_recent` and a scoped `parley_list_users` via {@link has}/{@link assert}.
 *
 * An unscoped `parley_list_users` is the UNION of the two: a peer counts when we can post to a topic
 * it subscribes to (POST/FETCH, pattern matches included) or it can post to one of ours (EXPLICIT).
 * So a peer on a topic reachable only through a `post_topics` pattern does appear there.
 *
 * A topic that names nothing is refused on both dimensions: the empty string is not a channel, and
 * the config loader already refuses it in `topics`/`post_topics`.
 *
 * There is no wildcard-everything default: patterns are opt-in and never widen subscribe. A
 * `reserved` topic (the presence topic) is refused on BOTH dimensions — a broad pattern can
 * never make it postable/fetchable, so a peer cannot spoof the presence roster.
 *
 * Inbound is untrusted (DESIGN §14): message content becomes agent context and is never treated
 * as a privileged instruction. A reply carries a caller-supplied topic and is gated by the same
 * POST/FETCH set as a post — so it reaches any explicit topic or `post_topics` match, and nothing
 * else. It is not confined to the topic the inbound message arrived from.
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
      if (t === '') throw new TopicNotAllowedError(t, EMPTY_TOPIC_REASON);
      if (this.reserved.has(t)) throw new TopicNotAllowedError(t); // reserved ∩ explicit is a config error
    }
    this.patternSources = opts.postPatterns ?? [];
    if (this.patternSources.length > MAX_POST_TOPICS)
      throw new RangeError(
        `an Allowlist holds at most ${MAX_POST_TOPICS} post patterns; got ` +
          `${this.patternSources.length}. Every one of them is matched against each ` +
          'caller-supplied topic, so the per-source backtracking screen bounds the work only ' +
          'while the count is bounded too.',
      );
    this.patternRegexes = this.patternSources.map((src) => {
      assertCompilesAlone(src);
      if (!isRedosSafeSource(src)) throw new UnsafePatternError(src);
      return new RegExp(`^(?:${src})$`);
    });
  }

  /** True if the topic may be posted to / fetched: explicit OR pattern match, never reserved. */
  has(topic: string): boolean {
    // Keep this refusal ahead of every other arm, so that a broad pattern cannot admit a topic the
    // config loader forbids and hand a backend an empty channel name.
    if (topic === '') return false;
    if (this.reserved.has(topic)) return false;
    if (this.allowed.has(topic)) return true;
    // Keep the input clamp, so that MAX_AMBIGUITY still bounds what a screened pattern can spend.
    if (topic.length > MAX_MATCH_INPUT) return false;
    return this.patternRegexes.some((re) => re.test(topic));
  }

  /** Return the branded Topic if postable/fetchable; otherwise throw {@link TopicNotAllowedError}. */
  assert(topic: string): Topic {
    if (this.has(topic)) return asTopic(topic);
    if (topic === '') throw new TopicNotAllowedError(topic, EMPTY_TOPIC_REASON);
    const overLong =
      this.patternRegexes.length > 0 &&
      topic.length > MAX_MATCH_INPUT &&
      !this.reserved.has(topic);
    if (overLong)
      throw new TopicNotAllowedError(
        topic,
        `post_topics patterns are only matched against topics of at most ${MAX_MATCH_INPUT} ` +
          `characters (this one is ${topic.length}); list it in \`topics\` instead`,
      );
    throw new TopicNotAllowedError(topic);
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
