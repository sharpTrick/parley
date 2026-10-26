import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Message } from '../message.js';

/** Claude Code's channel notification method (verified against the live channels-reference). */
export const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel';

/**
 * The complete set of meta keys core emits. Keep every one an identifier — `msg-id` and friends are
 * SILENTLY DROPPED by Claude Code at render time (channels gate), and TypeScript places no identifier
 * constraint on a string-literal type, so nothing here would flag one. The key shape and the exact
 * key set are pinned by the assertions in channel-emit.test.ts.
 */
type ChannelMetaKey = 'topic' | 'sender' | 'cursor' | 'msg_id' | 'mentions';

interface ChannelNotification {
  method: typeof CHANNEL_NOTIFICATION_METHOD;
  params: { content: string; meta: Record<string, string> };
}

/**
 * Map a Message to the channel event's `meta` (rendered as `<channel>` attributes). All keys
 * are identifiers ({@link ChannelMetaKey}) — NEVER `msg-id`, which would be silently dropped.
 *
 * VALUES are forwarded verbatim, and several of them (`sender` above all) are writer-controlled on
 * backends that let a peer pick its own display name. Structured escaping is the renderer's job:
 * `content` is arbitrary prose that core can never sanitize without destroying the product, so a
 * meta-only guard would buy no containment. Core's defence is the trust framing — inbound text is
 * DATA, never instructions (DESIGN §14, CHANNEL_INSTRUCTIONS).
 */
export function channelMeta(m: Message): Record<string, string> {
  const meta: Record<string, string> = {};
  const put = (key: ChannelMetaKey, value: string): void => {
    meta[key] = value;
  };
  put('topic', m.topic);
  put('sender', m.senderHandle);
  put('cursor', m.cursor);
  put('msg_id', m.backendMsgId);
  if (m.mentions.length > 0) put('mentions', m.mentions.join(','));
  return meta;
}

/**
 * Emit one Message as a `notifications/claude/channel` event (DESIGN §9; channel-docs gate).
 * Claude renders it as `<channel source="parley" topic=… sender=… cursor=… msg_id=…>content</channel>`.
 * The content is the raw body; all structured fields live in `meta`.
 *
 * Best-effort: notifications are not acknowledged and drop silently if no session is listening;
 * the cursor reconciles any loss via fetchRecent (§6). Single backend-agnostic emit path used
 * across every backend (polling or event-driven).
 */
export async function emitChannel(server: McpServer, m: Message): Promise<void> {
  const notification: ChannelNotification = {
    method: CHANNEL_NOTIFICATION_METHOD,
    params: { content: m.content, meta: channelMeta(m) },
  };
  // The channel method is a Claude Code extension outside the SDK's ServerNotification union, so
  // we reach the underlying low-level Server (McpServer's sanctioned escape hatch for custom
  // notifications) and cast at this single boundary. Verified at runtime: Server.notification
  // forwards any {method, params} over the transport unchanged.
  const low = server.server;
  await low.notification(notification as unknown as Parameters<typeof low.notification>[0]);
}
