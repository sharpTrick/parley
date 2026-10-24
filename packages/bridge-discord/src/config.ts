import {
  assertKnownConfigKeys,
  type BackendConfig,
  type BackendConfigKeys,
  boundedLine,
  isPlainObject,
  MAX_TIMER_MS,
  type Topic,
} from '@sharptrick/parley-core';
import { IDENTIFY_QUOTA_PER_DAY } from './ladder.js';

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
   * {@link IDENTIFY_QUOTA_PER_DAY} allowance is per BOT TOKEN, not per process, so every pacing
   * figure the ladder applies is multiplied by this. Integer ≥ 1; default 1.
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

/** Most dialers one token's IDENTIFY quota can still give one IDENTIFY each per window. */
export const MAX_DIALERS = IDENTIFY_QUOTA_PER_DAY;

/**
 * What a declared `backend_config` value must BE. Core parses `backend_config` as an unchecked
 * record, so every value arrives as whatever the YAML held: each one below reaches a URL a
 * credentialed call is sent to, a `setTimeout` delay, or the channel id a topic is routed to.
 */
export type ConfigShape = 'text' | 'channel map' | 'timer ms' | 'dialer count' | 'nested object';

/** What a value IS. Keep a refusal off what a value HOLDS, so that it cannot print a bot token. */
const typeName = (value: unknown): string => {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
};

/** A figure names itself; anything else is described by type only, for the same reason. */
const figure = (value: unknown): string =>
  typeof value === 'number' ? String(value) : typeName(value);

const wholeIn = (value: unknown, from: number, to: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= from && value <= to;

/**
 * Why each {@link ConfigShape} refuses a value, or `undefined` for one it accepts. `nested object`
 * is the one shape with no check of its own: {@link assertKnownConfigKeys} already refuses a
 * non-object and an undeclared member for every key it is handed under `nested`.
 */
const SHAPE_REFUSALS: Record<ConfigShape, (value: unknown) => string | undefined> = {
  text: (value) =>
    typeof value === 'string' ? undefined : `expected a string, got ${typeName(value)}`,

  'channel map': (value) => {
    if (!isPlainObject(value)) {
      return `expected an object of topic → channel id, got ${typeName(value)}`;
    }
    for (const [topic, channel] of Object.entries(value)) {
      if (typeof channel !== 'string') {
        return (
          `the channel id for topic ${JSON.stringify(boundedLine(topic))} is ${typeName(channel)}, not a ` +
          "string; a Discord channel id is 17-19 digits and exceeds JavaScript's exact integer " +
          'range, so quote it'
        );
      }
      if (channel === '') return `the channel id for topic ${JSON.stringify(boundedLine(topic))} is empty`;
    }
    return undefined;
  },

  'timer ms': (value) =>
    wholeIn(value, 1, MAX_TIMER_MS)
      ? undefined
      : `expected a whole number of milliseconds from 1 to ${MAX_TIMER_MS} (Node's timer range; ` +
        `a fractional, zero, negative or larger delay fires at 1ms instead), got ${figure(value)}`,

  'dialer count': (value) =>
    wholeIn(value, 1, MAX_DIALERS)
      ? undefined
      : `expected an integer from 1 to ${MAX_DIALERS} (how many instances share this bot token ` +
        `and open a gateway socket; each gets an equal share of the token's ` +
        `${IDENTIFY_QUOTA_PER_DAY}-IDENTIFY daily quota, which cannot go below one), got ${figure(value)}`,

  'nested object': () => undefined,
};

/**
 * Every name `backend_config` declares, and the shape its VALUE must have. Keep the `satisfies` on
 * each object, so that a key added to {@link DiscordBackendConfig} or {@link AllowedMentions}
 * without being listed here is a compile error rather than a key `connect()` rejects — and, for
 * this one, a key that reaches a URL, a timer or a route with no declared shape at all.
 */
export const CONFIG_SHAPES = {
  token: 'text',
  api_url: 'text',
  gateway_url: 'text',
  channel_map: 'channel map',
  handshake_timeout_ms: 'timer ms',
  gateway_dialers: 'dialer count',
  allowed_mentions: 'nested object',
} satisfies Record<keyof Required<DiscordBackendConfig>, ConfigShape>;

const CONFIG_KEYS: BackendConfigKeys = {
  keys: Object.keys(CONFIG_SHAPES),
  nested: {
    allowed_mentions: Object.keys({
      parse: 0,
      users: 0,
      roles: 0,
      replied_user: 0,
    } satisfies Record<keyof Required<AllowedMentions>, 0>),
  },
};

/**
 * Refuse a `backend_config` key this plugin does not implement, and a value it cannot use, ahead of
 * every other check. A misspelled `channel_map` uses every topic string as a literal channel id,
 * and a misspelled `allowed_mentions` leaves the mention blast radius at
 * {@link DEFAULT_ALLOWED_MENTIONS} while the operator believes they narrowed it — both silently.
 */
export function assertKnownBackendConfig(config: BackendConfig): void {
  assertKnownConfigKeys('discord', config, CONFIG_KEYS);
  const cfg = config as Record<string, unknown>;
  for (const [key, shape] of Object.entries(CONFIG_SHAPES)) {
    const value = cfg[key];
    if (value === undefined) continue;
    const refusal = SHAPE_REFUSALS[shape](value);
    if (refusal !== undefined) {
      throw new Error(`Discord backend_config.${key} is not accepted: ${refusal}`);
    }
  }
}

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
        `Discord channel_map maps both ${JSON.stringify(boundedLine(prior))} and ` +
          `${JSON.stringify(boundedLine(topic))} to ` +
          `channel ${channel}; each topic needs its own channel`,
      );
    }
    owner.set(channel, topic);
  }
  return owner;
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
