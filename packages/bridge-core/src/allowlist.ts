import { asTopic, type Topic } from './message.js';

/** Raised when a tool call or subscription targets a topic outside the allowlist. */
export class TopicNotAllowedError extends Error {
  constructor(public readonly topic: string) {
    super(`topic not allowed: ${JSON.stringify(topic)}`);
    this.name = 'TopicNotAllowedError';
  }
}

/**
 * The topic allowlist (DESIGN §14). The bridge only subscribes to / catches up on / posts to
 * an explicit list of topics — `config.topics` IS the allowlist; there is no
 * wildcard-everything default. A single guard (`assert`) gates every tool entry point
 * (`post`/`reply`/`fetch_recent`) and is the only set `subscribe` iterates.
 *
 * Inbound is untrusted (DESIGN §14): message content becomes agent context and is never
 * treated as a privileged instruction. A reply always targets the inbound topic, which is
 * subscribed and therefore already allowed.
 */
export class Allowlist {
  private readonly allowed: Set<string>;

  constructor(topics: Iterable<string>) {
    this.allowed = new Set(topics);
  }

  has(topic: string): boolean {
    return this.allowed.has(topic);
  }

  /** Return the branded Topic if allowed; otherwise throw {@link TopicNotAllowedError}. */
  assert(topic: string): Topic {
    if (!this.allowed.has(topic)) throw new TopicNotAllowedError(topic);
    return asTopic(topic);
  }

  /** Every allowed topic, branded. */
  topics(): Topic[] {
    return [...this.allowed].map(asTopic);
  }
}
