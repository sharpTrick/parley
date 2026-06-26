import type { BackendMsgId, Topic } from '../message.js';

/**
 * Per-topic dedup set keyed on `backendMsgId` (DESIGN §6 — NEVER on timestamp).
 *
 * The same logical message can arrive twice: once via live push, once via `fetchRecent`
 * (a session that briefly dropped and reconnected). Core dedups on the stable backend id.
 *
 * Bounded FIFO per topic so memory stays flat. The window only needs to cover the overlap
 * between a catch-up pull and the live poll — cursor monotonicity prevents re-fetching
 * ancient ids — so a few thousand ids per topic is ample.
 */
export class SeenSet {
  private readonly sets = new Map<Topic, Set<BackendMsgId>>();
  private readonly queues = new Map<Topic, BackendMsgId[]>();

  constructor(private readonly maxPerTopic = 4096) {}

  private bucket(topic: Topic): { set: Set<BackendMsgId>; queue: BackendMsgId[] } {
    let set = this.sets.get(topic);
    let queue = this.queues.get(topic);
    if (set === undefined || queue === undefined) {
      set = new Set<BackendMsgId>();
      queue = [];
      this.sets.set(topic, set);
      this.queues.set(topic, queue);
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
