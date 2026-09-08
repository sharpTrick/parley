import {
  assertKnownConfigKeys,
  parseMentions,
  type BackendConfigKeys,
  MAX_TIMER_MS,
} from '@sharptrick/parley-core';

export { MAX_TIMER_MS };
import { isHttpUrl, plaintextRemoteOrigin } from '@sharptrick/parley-net-util';
import { SlackShapeError } from './api.js';
import { DEFAULT_HANDSHAKE_TIMEOUT_MS, DEFAULT_ROTATION_GRACE_MS } from './socket.js';

export const DEFAULT_API_URL = 'https://slack.com/api';

/** Plugin-specific backend_config. */
export interface SlackBackendConfig {
  /** Bot token (`xoxb-…`) — Web API calls: `chat.postMessage`, `conversations.history`, …. */
  bot_token?: string;
  /** App-level token (`xapp-…`) with `connections:write` — Socket Mode (`apps.connections.open`). */
  app_token?: string;
  /** Web API base URL. Default `https://slack.com/api` (tests point this at an in-process fake). */
  api_url?: string;
  /**
   * Parley topic → Slack channel id (e.g. `{"ctx-payments": "C0123456789"}`). A topic with no
   * entry is used as a channel-id literal, so topics that already ARE channel ids need no map.
   */
  channel_map?: Record<string, string>;
  /**
   * Slack user/usergroup id → Parley handle (e.g. `{"U0PARLEY": "ctx-payments"}`), applied when
   * rewriting `<@U…>` mention markup into the `@handle` form core's mention filter reads.
   */
  mention_map?: Record<string, string>;
  /** Milliseconds a Socket Mode connection may stay silent after opening before `hello`. */
  handshake_timeout_ms?: number;
  /** Milliseconds a rotated-out Socket Mode connection may stay open after its replacement is up. */
  rotation_grace_ms?: number;
}

/**
 * A {@link SlackBackendConfig} that has been through {@link resolveConfig}. Keep the plugin and
 * everything it composes reading THIS, so that no module re-applies a default the load path owns.
 */
export interface SlackSettings {
  apiUrl: string;
  botToken?: string;
  appToken?: string;
  channelMap: Record<string, string>;
  mentionMap: Record<string, string>;
  handshakeTimeoutMs: number;
  rotationGraceMs: number;
}

/**
 * Every `backend_config` key whose value is handed straight to `setTimeout`. Keep
 * {@link validateConfig} iterating THIS list rather than naming the knobs it happens to know about,
 * so that a timing knob added to {@link SlackBackendConfig} is unchecked in exactly one place.
 */
export const TIMER_CONFIG_KEYS = ['handshake_timeout_ms', 'rotation_grace_ms'] as const;

/** Every `backend_config` key spent as an `Authorization: Bearer` credential. */
export const TOKEN_CONFIG_KEYS = ['bot_token', 'app_token'] as const;

/**
 * The grammar a map's DESTINATION imposes on a value, beyond "a non-empty string". A destination
 * that re-parses the value — rather than just carrying it — has one, and a value the type check
 * admits but the grammar cannot round-trip is accepted at load and then silently inert.
 */
export interface MapValueGrammar {
  accepts: (value: string) => boolean;
  /** What the operator has to change, phrased for stderr. */
  requirement: string;
}

/**
 * `mention_map` values are spliced into content as `@${value}` and read back by core's
 * {@link parseMentions}, so a value that does not survive that round trip produces NO mention at
 * all — and `live_push.mention_filter` armed on it then drops every message addressed to it, in
 * silence. Derive the predicate from the exported parser rather than restating its character class,
 * so that the check cannot drift from the grammar it exists to agree with. (Core's own
 * `isMentionableHandle` is the same predicate but is not on its public export surface — a seam gap,
 * not a licence to reach into core's source tree.)
 */
export const MENTIONABLE_HANDLE: MapValueGrammar = {
  accepts: (value) => parseMentions(`@${value}`)[0] === value,
  requirement:
    'an @-mention of it must parse back to exactly it (alphanumeric at both ends; interior ' +
    '"." "_" "-" only), or core\'s mention filter can never match it',
};

/**
 * Reject a `backend_config` lookup table that is not one, or whose values cannot be used as ones.
 * Every value reaches either the wire (`channel_map`) or a `Message` field (`mention_map`), so keep
 * this fail-fast at load, so that a blank or non-string value cannot reach the wire as `"undefined"`
 * or cross the seam as an empty `senderHandle`.
 *
 * The CONTAINER is checked first, and as a load error rather than a coercion: `Object.entries`
 * destructures a string as happily as an object, so `channel_map: "C0123"` would become
 * `{"0":"C","1":"0",…}` and every configured topic would fall through to the channel-id-literal
 * branch — a bridge that comes up reporting success and is wired to nothing.
 *
 * Keep the type check AHEAD of `grammar`, so that a non-string value is still refused by the shape
 * it failed rather than by a predicate that was never written to read one.
 */
export function requireUsableMap(
  configKey: string,
  what: string,
  map: unknown,
  grammar?: MapValueGrammar,
): Record<string, string> {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    throw new Error(
      `Slack backend_config.${configKey} = ${JSON.stringify(map) ?? String(map)} is not accepted: ` +
        `expected an object mapping each key to ${what}`,
    );
  }
  // Keep both config maps rebuilt with NO prototype chain, so that a key like `__proto__` or
  // `toString` — legal in core's `topics` and reachable straight from untrusted inbound mention
  // markup — cannot answer with an `Object.prototype` member.
  const checked = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `Slack ${configKey} maps ${JSON.stringify(key)} to ${JSON.stringify(value)}, ` +
          `which is not ${what}`,
      );
    }
    if (grammar !== undefined && !grammar.accepts(value)) {
      throw new Error(
        `Slack ${configKey} maps ${JSON.stringify(key)} to ${JSON.stringify(value)}, ` +
          `which is not ${what}: ${grammar.requirement}`,
      );
    }
    checked[key] = value;
  }
  return checked;
}

/**
 * The above, plus `channel_map`'s own many-to-one hazard: two topics folding onto one channel
 * silently displace each other's route and relabel one topic's traffic as the other's, crossing into
 * a different topic's dedup and allowlist namespace.
 */
export function requireUsableChannelMap(map: unknown): Record<string, string> {
  const checked = requireUsableMap('channel_map', 'a channel id', map);
  const owner = new Map<string, string>();
  for (const [topic, channel] of Object.entries(checked)) {
    const prior = owner.get(channel);
    if (prior !== undefined) {
      throw new Error(
        `Slack channel_map maps both ${JSON.stringify(prior)} and ${JSON.stringify(topic)} to ` +
          `channel ${channel}; each topic needs its own channel`,
      );
    }
    owner.set(channel, topic);
  }
  return checked;
}

/**
 * The websocket URL `apps.connections.open` handed us, or a named refusal. A vendor response is
 * untrusted input, not an authorization: this URL carries the single-use Socket Mode ticket, every
 * workspace message and every ack, so it is held to no weaker a transport guarantee than the one
 * the operator configured for the Web API. `ws:` therefore passes only where a plaintext `api_url`
 * would, and never silently downgrades an `https:` workspace toward a host nobody configured.
 */
export function requireUsableSocketUrl(apiUrl: string, url: unknown): string {
  if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) {
    throw new SlackShapeError('apps.connections.open', 'returned no usable websocket url');
  }
  const insecure = plaintextRemoteOrigin(url);
  if (insecure !== undefined && plaintextRemoteOrigin(apiUrl) === undefined) {
    throw new SlackShapeError(
      'apps.connections.open',
      `returned ${insecure}, a plaintext websocket to a non-loopback host, while ` +
        `backend_config.api_url ${apiUrl} is not — refusing to downgrade the live stream`,
    );
  }
  return url;
}

/**
 * Every name `backend_config` declares. Keep the `satisfies` on it, so that a key added to
 * {@link SlackBackendConfig} without being listed here is a compile error rather than a key
 * `connect()` rejects.
 */
const CONFIG_KEYS: BackendConfigKeys = {
  keys: Object.keys({
    bot_token: 0,
    app_token: 0,
    api_url: 0,
    channel_map: 0,
    mention_map: 0,
    handshake_timeout_ms: 0,
    rotation_grace_ms: 0,
  } satisfies Record<keyof Required<SlackBackendConfig>, 0>),
};

/**
 * Reject every `backend_config` value the declared type cannot enforce at run time. Core loads
 * `backend_config` as `z.record(z.unknown())`, so each value below arrives unchecked and reaches
 * either the URL every credentialed call is sent to or a `setTimeout` delay. Keep this a LOAD ERROR
 * rather than a coercion, so that a timing knob outside Node's timer range fails instead of
 * silently clamping to 1ms — which disables the very bound the knob exists to set.
 */
function validateConfig(cfg: SlackBackendConfig): void {
  assertKnownConfigKeys('slack', cfg, CONFIG_KEYS);
  const reject = (key: keyof SlackBackendConfig, expected: string): never => {
    const raw = cfg[key];
    throw new Error(
      `Slack backend_config.${key} = ` +
        `${typeof raw === 'string' ? JSON.stringify(raw) : String(raw)} is not accepted: ` +
        `expected ${expected}`,
    );
  };
  if (cfg.api_url !== undefined && (typeof cfg.api_url !== 'string' || !isHttpUrl(cfg.api_url))) {
    reject('api_url', 'an http(s) URL');
  }
  for (const key of TIMER_CONFIG_KEYS) {
    const value = cfg[key];
    if (value !== undefined && !(Number.isInteger(value) && value > 0 && value <= MAX_TIMER_MS)) {
      reject(key, `a positive whole number of milliseconds, at most ${MAX_TIMER_MS}`);
    }
  }
  for (const key of TOKEN_CONFIG_KEYS) {
    const value = cfg[key];
    if (value !== undefined && typeof value !== 'string') reject(key, 'a string');
  }
}

/**
 * Every rejection a `backend_config` can earn, in one pass that changes nothing — so that a caller
 * can refuse a config before standing down the connection the refused one would have replaced.
 */
export function resolveConfig(cfg: SlackBackendConfig): SlackSettings {
  validateConfig(cfg);
  return {
    apiUrl: (cfg.api_url ?? DEFAULT_API_URL).replace(/\/+$/, ''),
    botToken: cfg.bot_token,
    appToken: cfg.app_token,
    // `=== undefined`, never `??`: a null map is a value the declared type does not allow, and
    // defaulting it here would accept it as "no map configured" instead of failing at load.
    channelMap: requireUsableChannelMap(cfg.channel_map === undefined ? {} : cfg.channel_map),
    mentionMap: requireUsableMap(
      'mention_map',
      'a handle',
      cfg.mention_map === undefined ? {} : cfg.mention_map,
      MENTIONABLE_HANDLE,
    ),
    handshakeTimeoutMs: cfg.handshake_timeout_ms ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    rotationGraceMs: cfg.rotation_grace_ms ?? DEFAULT_ROTATION_GRACE_MS,
  };
}

/**
 * Every config shape that widens this backend's trust boundary, phrased for the operator's stderr.
 * A risk documented only in the README is one an operator who copied a fixture config never sees,
 * so this warns from `connect` — a warning rather than a load error, because a plaintext endpoint is
 * a legitimate choice for a loopback fixture or a recording proxy.
 */
export function configRisks(cfg: SlackBackendConfig): string[] {
  const plaintext = plaintextRemoteOrigin(cfg.api_url ?? DEFAULT_API_URL);
  if (plaintext === undefined) return [];
  return [
    `backend_config.api_url ${plaintext} is plaintext http:// to a non-loopback host, so every Web ` +
      'API call carries backend_config.bot_token across the network in the clear as an ' +
      'Authorization header, and apps.connections.open carries backend_config.app_token the same ' +
      'way. Use https:// for any remote endpoint.',
  ];
}
