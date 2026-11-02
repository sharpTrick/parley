import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Allowlist } from '../allowlist.js';
import type { LiveDeliveryLedger } from '../engine/live-delivery.js';
import type { OwnPosts } from '../engine/own-posts.js';
import type { SeenSet } from '../engine/seen-set.js';
import type { Handle, Message } from '../message.js';
import { isNoSuchTopicError } from '../no-such-topic.js';
import type { BackendPlugin } from '../seam.js';
import { emitChannel } from './channel-emit.js';

export interface PushLoopOptions {
  /** When true, only surface messages mentioning `identity` (DESIGN §7 — a filter flag, not a subscription). */
  mentionFilter: boolean;
  identity: Handle;
  /**
   * Records that the live path delivered. Shared with the reconciling read, whose counter is the
   * other half of the comparison `parley_live_status` answers from.
   */
  live: LiveDeliveryLedger;
  /** What this bridge wrote, so that none of it is pushed back to the agent that wrote it. */
  own: OwnPosts;
  /** What the agent has been shown, which a post's read guard holds unread messages against. */
  handed: SeenSet;
}


/**
 * Whether a message reaching this instance live is one its agent is shown (DESIGN §7). A message
 * naming this instance reaches it on whatever topic it arrived from — an address is always a
 * mention too (seam.ts, `Message.addressed`). Otherwise only a followed topic's messages do, and not
 * one the backend marks as explicitly addressed to someone else.
 */
export function routesTo(m: Message, identity: Handle, opts: { followed: boolean; mentionFilter: boolean }): boolean {
  if (m.mentions.includes(identity)) return true;
  return opts.followed && (m.addressed ?? []).length === 0 && !opts.mentionFilter;
}

/**
 * Wire the live path: subscribe a SINGLE backend-agnostic handler to every allowed topic, and to
 * the backend's mention feed where it has one (DESIGN §7/§9). The handler is the one place
 * filtering lives:
 *   1. drop anything on a topic this instance may not read — subscribed, or (from the mention feed)
 *      allowed for post/fetch,
 *   2. record a delivery by a topic's own subscription, so `parley_live_status` can answer whether
 *      that path carries anything — a mention feed reaching the same topic is no evidence it does,
 *   3. dedup on backendMsgId (so a message already pulled via catch-up isn't re-pushed),
 *   4. drop what this bridge wrote itself,
 *   5. route on mentions — a message naming anyone reaches only those it names — in CORE, not in
 *      `subscribe` (the plugin forwards ALL messages),
 *   6. emit as a `<channel>` event (best-effort; the cursor reconciles any drop).
 *
 * Step 1 is a trust boundary, not a redundancy: `m.topic` is plugin-supplied and lands in the
 * agent's context, while a backend's subscribe primitive can be COARSER than a topic (a NATS
 * wildcard subject, a Matrix room carrying several logical topics). Re-checking it here is what
 * makes "the bridge only ever surfaces the topics it was configured for" (DESIGN §14) hold
 * structurally rather than depend on every plugin's care.
 *
 * Steps 4–6 run one message at a time, in arrival order: step 4 has to wait out any write still
 * in flight before it can recognise that write's echo, and later messages must not overtake it.
 *
 * A topic the backend cannot represent yet (`NoSuchTopicError`, recognised by contract via
 * {@link isNoSuchTopicError}) gets no live subscription and is skipped — the seam declares that
 * "absent", not a failure, so the remaining topics still go live. Every other rejection propagates
 * and fails the attach.
 */
export async function startPushLoop(
  server: McpServer,
  plugin: BackendPlugin,
  allow: Allowlist,
  seen: SeenSet,
  opts: PushLoopOptions,
): Promise<void> {
  const subscribed = new Set<string>(allow.topics());
  // Warn once per loop, not once per topic: the topic string is plugin-supplied, so a per-topic
  // ledger would be an unbounded map keyed by untrusted input.
  let warned = false;
  let queue: Promise<void> = Promise.resolve();
  const route = async (m: Message, followed: boolean): Promise<void> => {
    await opts.own.settled();
    if (opts.own.has(m.backendMsgId)) return;
    if (!routesTo(m, opts.identity, { followed, mentionFilter: opts.mentionFilter })) return;
    opts.handed.markSeen(m.topic, m.backendMsgId);
    await emitChannel(server, m);
  };
  const handlerFor = (fromMentionFeed: boolean) => (m: Message): void => {
    const followed = subscribed.has(m.topic);
    // A mention feed carries every topic by contract, so one outside the allowlist is expected
    // there and dropped quietly; from a topic subscription it is the plugin over-delivering.
    if (fromMentionFeed && !followed && !allow.has(m.topic)) return;
    if (!followed && !fromMentionFeed) {
      if (!warned) {
        warned = true;
        console.error(
          `[parley] dropping pushed messages on topics this instance may not read (first: ${JSON.stringify(m.topic)}); ` +
            'the backend plugin is delivering beyond what it was asked for',
        );
      }
      return;
    }
    // Count the message the live path CARRIED, ahead of every gate that decides whether the agent
    // is shown it: a pull that reached it first, its own echo, and a mention addressed elsewhere are
    // not a dead push path.
    if (followed && !fromMentionFeed) opts.live.recordPush(m.topic);
    if (!seen.firstSeen(m.topic, m.backendMsgId)) return;
    queue = queue.then(() => route(m, followed)).catch(() => {
      // Best-effort: a dropped push is harmless; core reconciles via fetchRecent (§6).
    });
  };
  const handler = handlerFor(false);
  for (const topic of allow.topics()) {
    try {
      await plugin.subscribe(topic, handler);
    } catch (err) {
      if (!isNoSuchTopicError(err)) throw err;
      console.error(
        `[parley] topic ${JSON.stringify(topic)} does not exist on the backend yet; no live subscription`,
      );
    }
  }
  if (plugin.subscribeMentions !== undefined) {
    await plugin.subscribeMentions(opts.identity, handlerFor(true));
  }
}
