import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Allowlist } from '../allowlist.js';
import type { SeenSet } from '../engine/seen-set.js';
import type { Handle, Message } from '../message.js';
import { isNoSuchTopicError } from '../no-such-topic.js';
import type { BackendPlugin } from '../seam.js';
import { emitChannel } from './channel-emit.js';

export interface PushLoopOptions {
  /** When true, only surface messages mentioning `identity` (DESIGN §7 — a filter flag, not a subscription). */
  mentionFilter: boolean;
  identity: Handle;
}

/**
 * Wire the live path: subscribe a SINGLE backend-agnostic handler to every allowed topic
 * (DESIGN §7/§9). The handler is the one place filtering lives:
 *   1. drop anything whose `topic` is not one we subscribed to,
 *   2. dedup on backendMsgId (so a message already pulled via catch-up isn't re-pushed),
 *   3. mention filter — in CORE, not in `subscribe` (the plugin forwards ALL messages),
 *   4. emit as a `<channel>` event (best-effort; the cursor reconciles any drop).
 *
 * Step 1 is a trust boundary, not a redundancy: `m.topic` is plugin-supplied and lands in the
 * agent's context, while a backend's subscribe primitive can be COARSER than a topic (a NATS
 * wildcard subject, a Matrix room carrying several logical topics). Re-checking it here is what makes
 * "the bridge only ever surfaces the topics it was configured for, and never a presence beat"
 * (DESIGN §14) hold structurally rather than depend on every plugin's care.
 *
 * The plugin owns the delivery mechanism (poll loop for SQLite; blocking events later); core's
 * emit path is identical across mechanisms, so push developed against polling exercises the
 * same path event-driven backends will drive.
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
  const handler = (m: Message): void => {
    if (!subscribed.has(m.topic)) {
      if (!warned) {
        warned = true;
        console.error(
          `[parley] dropping pushed messages on unsubscribed topics (first: ${JSON.stringify(m.topic)}); ` +
            'the backend plugin is delivering beyond the topics it was asked to subscribe',
        );
      }
      return;
    }
    if (!seen.firstSeen(m.topic, m.backendMsgId)) return;
    if (opts.mentionFilter && !m.mentions.includes(opts.identity)) return;
    void emitChannel(server, m).catch(() => {
      // Best-effort: a dropped push is harmless; core reconciles via fetchRecent (§6).
    });
  };
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
}
