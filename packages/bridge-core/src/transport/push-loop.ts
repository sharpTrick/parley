import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Allowlist } from '../allowlist.js';
import type { SeenSet } from '../engine/seen-set.js';
import type { Handle, Message } from '../message.js';
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
 *   1. dedup on backendMsgId (so a message already pulled via catch-up isn't re-pushed),
 *   2. mention filter — in CORE, not in `subscribe` (the plugin forwards ALL messages),
 *   3. emit as a `<channel>` event (best-effort; the cursor reconciles any drop).
 *
 * The plugin owns the delivery mechanism (poll loop for SQLite; blocking events later); core's
 * emit path is identical across mechanisms, so push developed against polling exercises the
 * same path event-driven backends will drive.
 */
export async function startPushLoop(
  server: Server,
  plugin: BackendPlugin,
  allow: Allowlist,
  seen: SeenSet,
  opts: PushLoopOptions,
): Promise<void> {
  const handler = (m: Message): void => {
    if (!seen.firstSeen(m.topic, m.backendMsgId)) return;
    if (opts.mentionFilter && !m.mentions.includes(opts.identity)) return;
    void emitChannel(server, m).catch(() => {
      // Best-effort: a dropped push is harmless; core reconciles via fetchRecent (§6).
    });
  };
  for (const topic of allow.topics()) {
    await plugin.subscribe(topic, handler);
  }
}
