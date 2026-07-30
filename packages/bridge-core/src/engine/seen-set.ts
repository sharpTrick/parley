import type { BackendMsgId, Topic } from '../message.js';

/**
 * The dedup window every composition root gets: `new SeenSet()` takes no arguments, so these two
 * numbers ARE the production capacity. Exported so the suite can grade the default-constructed
 * instance against them instead of only against injected test values.
 */
export const SEEN_MAX_PER_TOPIC = 4096;
export const SEEN_MAX_TOPICS = 256;

/**
 * Per-topic dedup set keyed on `backendMsgId` (DESIGN §6 — NEVER on timestamp).
 *
 * The same logical message can arrive twice: once via live push, once via `fetchRecent`
 * (a session that briefly dropped and reconnected). Core dedups on the stable backend id.
 *
 * Bounded FIFO per topic so memory stays flat. The window only needs to cover the overlap
 * between a catch-up pull and the live poll — cursor monotonicity prevents re-fetching
 * ancient ids — so a few thousand ids per topic is ample.
 *
 * The NUMBER of topics is bounded too, LRU. A `post_topics` pattern leaves the topic space open and
 * `fetch_recent` warms a bucket for whatever topic it is handed, so an agent reading ad-hoc topics
 * would otherwise grow this map for the process lifetime. Eviction costs at most a duplicate
 * `<channel>` emit on a topic that has gone cold — the push loop's own topics stay hot.
 */
export class SeenSet {
  private readonly sets = new Map<Topic, Set<BackendMsgId>>();
  private readonly queues = new Map<Topic, BackendMsgId[]>();

  constructor(
    private readonly maxPerTopic = SEEN_MAX_PER_TOPIC,
    private readonly maxTopics = SEEN_MAX_TOPICS,
  ) {}

  private bucket(topic: Topic): { set: Set<BackendMsgId>; queue: BackendMsgId[] } {
    let set = this.sets.get(topic);
    let queue = this.queues.get(topic);
    if (set === undefined || queue === undefined) {
      set = new Set<BackendMsgId>();
      queue = [];
    } else {
      this.sets.delete(topic);
      this.queues.delete(topic);
    }
    this.sets.set(topic, set);
    this.queues.set(topic, queue);
    for (const stale of this.sets.keys()) {
      if (this.sets.size <= this.maxTopics) break;
      this.sets.delete(stale);
      this.queues.delete(stale);
    }
    return { set, queue };
  }

  private record(topic: Topic, id: BackendMsgId): void {
    const { set, queue } = this.bucket(topic);
    if (set.has(id)) return;
    set.add(id);
    queue.push(id);
    if (queue.length > this.maxPerTopic) {
      const evicted = queue.shift();
      if (evicted !== undefined) set.delete(evicted);
    }
  }

  /**
   * Returns `true` the FIRST time `(topic, id)` is seen and records it; `false` on repeats.
   * This is the dedup gate on the push-emit path.
   */
  firstSeen(topic: Topic, id: BackendMsgId): boolean {
    if (this.sets.get(topic)?.has(id) ?? false) return false;
    this.record(topic, id);
    return true;
  }

  /**
   * Record `(topic, id)` as seen without reporting first-ness — used to warm the set from
   * `fetchRecent` results so the poll loop won't re-push a message the agent already pulled.
   */
  markSeen(topic: Topic, id: BackendMsgId): void {
    this.record(topic, id);
  }

  /** Membership test that does not record. */
  has(topic: Topic, id: BackendMsgId): boolean {
    return this.sets.get(topic)?.has(id) ?? false;
  }
}
