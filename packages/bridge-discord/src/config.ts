import type { Topic } from '@sharptrick/parley-core';
import { RECONNECT_CAP_MS } from './ladder.js';

/** Plugin-specific backend_config. */
export interface DiscordBackendConfig {
  /** Bot token (Discord developer portal → Bot → Token). Sent as `Authorization: Bot <token>`. */
  token?: string;
  /** REST base URL. Default `https://discord.com/api/v10`. Tests point this at a local fake. */
  api_url?: string;
  /** Gateway websocket URL override. Default: resolved via `GET /gateway/bot` on first subscribe. */
  gateway_url?: string;
  /**
   * Parley topic → Discord channel id. An UNMAPPED topic string is used as a channel id
   * literal — the zero-config path when your topics simply ARE channel ids. Values must be
   * DISTINCT: two topics folding onto one channel is rejected at `connect()`.
   */
  channel_map?: Record<string, string>;
  /** How long HELLO → IDENTIFY → READY may take before the socket is terminated. Default 10000. */
  handshake_timeout_ms?: number;
  /**
   * How many bridge instances share this bot token AND open a gateway socket. Discord's
   * 1000-IDENTIFY-per-24h quota is per BOT TOKEN, not per process, so the reconnect ceiling
   * ({@link RECONNECT_CAP_MS}) is multiplied by this. Integer ≥ 1; default 1.
   */
  gateway_dialers?: number;
  /**
   * Mention scope for every `post`. Default `{ parse: ['users'], replied_user: false }` — widen it
   * only deliberately: `@everyone`/`@here`/role pings reach the whole guild, and `post` content can
   * be untrusted inbound text an agent relayed (DESIGN §14).
   */
  allowed_mentions?: AllowedMentions;
}

/** Discord's `allowed_mentions` object — the blast radius of a `post`'s mention markup. */
export interface AllowedMentions {
  parse?: string[];
  users?: string[];
  roles?: string[];
  replied_user?: boolean;
}

export const DEFAULT_ALLOWED_MENTIONS: AllowedMentions = { parse: ['users'], replied_user: false };

/**
 * Reject a `channel_map` whose targets are not distinct, and return the channel id → owning topic
 * reverse index. Two topics folding onto one channel silently drops one topic's subscription and
 * relabels its traffic as the other's.
 */
export function requireDistinctChannels(map: Map<string, string>): Map<string, string> {
  const owner = new Map<string, string>();
  for (const [topic, channel] of map) {
    const prior = owner.get(channel);
    if (prior !== undefined) {
      throw new Error(
        `Discord channel_map maps both ${JSON.stringify(prior)} and ${JSON.stringify(topic)} to ` +
          `channel ${channel}; each topic needs its own channel`,
      );
    }
    owner.set(channel, topic);
  }
  return owner;
}

/**
 * Reject a `gateway_dialers` that is not an integer ≥ 1, and return the reconnect ceiling it buys.
 * It divides ONE token's IDENTIFY quota, so a zero or fractional value would silently SHRINK that
 * ceiling instead of widening it, and overrunning the quota resets the token.
 */
export function requireReconnectCap(value: number | undefined): number {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new Error(
      `Discord gateway_dialers must be an integer >= 1 (how many instances share this bot ` +
        `token and open a gateway socket); got ${JSON.stringify(value)}`,
    );
  }
  return RECONNECT_CAP_MS * (value ?? 1);
}

/**
 * Refuse a channel id that cannot survive as a path segment. `encodeURIComponent` leaves `.` and
 * `..` untouched, but those are DOT SEGMENTS the URL parser removes, so such an id silently
 * retargets the call at a different Discord route. Keep the refusal HERE, so that every entry point
 * resolving a topic is covered by one check.
 */
export function requireRoutableChannel(topic: Topic, id: string): string {
  if (id === '' || /^\.{1,2}$/.test(id)) {
    throw new Error(
      `Discord topic ${JSON.stringify(topic as string)} resolves to channel id ` +
        `${JSON.stringify(id)}, which is not a usable URL path segment; point the topic at a real ` +
        'channel id (directly or through channel_map)',
    );
  }
  return id;
}
