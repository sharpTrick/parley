import { plaintextRemoteOrigin } from '@sharptrick/parley-net-util';
import { DEFAULT_API_URL } from './api.js';
import type { SlackBackendConfig } from './index.js';

/** Largest delay Node's timers accept; past it every one of them silently becomes 1ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Every `backend_config` key whose value is handed straight to `setTimeout`. Keep
 * {@link validateConfig} iterating THIS list rather than naming the knobs it happens to know about,
 * so that a timing knob added to {@link SlackBackendConfig} is unchecked in exactly one place.
 */
export const TIMER_CONFIG_KEYS = ['handshake_timeout_ms', 'rotation_grace_ms'] as const;

/** Every `backend_config` key spent as an `Authorization: Bearer` credential. */
export const TOKEN_CONFIG_KEYS = ['bot_token', 'app_token'] as const;

/**
 * A config lookup table with NO prototype chain. Keep both config maps built this way, so that a
 * key like `__proto__` or `toString` — legal in core's `topics` and reachable straight from
 * untrusted inbound mention markup — cannot answer with an `Object.prototype` member.
 */
export function ownEntriesOnly<T>(map: Record<string, T>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of Object.entries(map)) out[key] = value;
  return out;
}

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
 */
export function requireUsableMap(
  configKey: string,
  what: string,
  map: unknown,
): Record<string, string> {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    throw new Error(
      `Slack backend_config.${configKey} = ${JSON.stringify(map) ?? String(map)} is not accepted: ` +
        `expected an object mapping each key to ${what}`,
    );
  }
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `Slack ${configKey} maps ${JSON.stringify(key)} to ${JSON.stringify(value)}, ` +
          `which is not ${what}`,
      );
    }
  }
  return ownEntriesOnly(map as Record<string, string>);
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

const isHttpUrl = (s: string): boolean => {
  try {
    const { protocol } = new URL(s);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Reject every `backend_config` value the declared type cannot enforce at run time. Core loads
 * `backend_config` as `z.record(z.unknown())`, so each value below arrives unchecked and reaches
 * either the URL every credentialed call is sent to or a `setTimeout` delay. Keep this a LOAD ERROR
 * rather than a coercion, so that a timing knob outside Node's timer range fails instead of
 * silently clamping to 1ms — which disables the very bound the knob exists to set.
 */
export function validateConfig(cfg: SlackBackendConfig): void {
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
