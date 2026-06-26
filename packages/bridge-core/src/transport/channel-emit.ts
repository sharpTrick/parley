import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Message } from '../message.js';

/** Claude Code's channel notification method (verified against the live channels-reference). */
export const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel';

// Meta KEYS must be identifiers — Claude Code SILENTLY DROPS hyphenated keys (channels gate).
// Values may contain hyphens (e.g. a handle "ctx-payments"); only keys are constrained.
const META_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface ChannelNotification {
  method: typeof CHANNEL_NOTIFICATION_METHOD;
  params: { content: string; meta: Record<string, string> };
}

/**
 * Map a Message to the channel event's `meta` (rendered as `<channel>` attributes). All keys
 * are identifiers (`topic`, `sender`, `cursor`, `msg_id`, `mentions`) — NEVER `msg-id`, which
 * would be silently dropped. Throws if a key is somehow not an identifier (defensive guard).
 */
export function channelMeta(m: Message): Record<string, string> {
  const meta: Record<string, string> = {
    topic: m.topic,
    sender: m.senderHandle,
    cursor: m.cursor,
    msg_id: m.backendMsgId,
  };
  if (m.mentions.length > 0) meta.mentions = m.mentions.join(',');
  for (const key of Object.keys(meta)) {
    if (!META_KEY_RE.test(key)) {
      throw new Error(`channel meta key is not an identifier (would be silently dropped): ${key}`);
    }
  }
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
export async function emitChannel(server: Server, m: Message): Promise<void> {
  const notification: ChannelNotification = {
    method: CHANNEL_NOTIFICATION_METHOD,
    params: { content: m.content, meta: channelMeta(m) },
  };
  // The channel method is a Claude Code extension outside the SDK's ServerNotification union,
  // so we cast at this single boundary. Verified at runtime: Server.notification forwards any
  // {method, params} over the transport unchanged.
  await server.notification(notification as unknown as Parameters<typeof server.notification>[0]);
}
