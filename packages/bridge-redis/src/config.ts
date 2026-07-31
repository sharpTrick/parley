/** The endpoint `url` falls back to when omitted (or `null`). Exported so a test can name it
 * without hard-coding an endpoint of its own. */
export const DEFAULT_URL = 'redis://127.0.0.1:6379';
const DEFAULT_KEY_PREFIX = 'parley:';
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_BLOCK_MS = 2000;

/** Every key `backend_config` may carry; anything else is a typo and is rejected by `connect()`. */
export const CONFIG_KEYS = [
  'url',
  'key_prefix',
  'block_ms',
  'connect_timeout_ms',
  'retention_days',
] as const;

export interface RedisBackendConfig {
  /** Connection URL. Default `redis://127.0.0.1:6379`. */
  url?: string;
  /** Stream key prefix. Default `parley:`. One Redis Stream per topic: `<prefix><topic>`. */
  key_prefix?: string;
  /**
   * `XREAD BLOCK` timeout (ms) — how long a read parks before re-arming on an idle stream. A cost
   * knob only: delivery is driven by the read waking, and `disconnect()` destroys the reader socket
   * rather than waiting out the interval. Default 2000; must be a positive whole number.
   */
  block_ms?: number;
  /**
   * How long the FIRST handshake (and its verifying `PING`) may take before `connect()` rejects
   * (ms). Default 5000; must be a positive whole number.
   */
  connect_timeout_ms?: number;
  /**
   * Optional retention window in days: entries older than this are (approximately) trimmed on every
   * `post` via `XADD`'s own `MINID` option — no separate job or connection, so a topic with no new
   * posts is not trimmed until its next one. Omit (or `null`) to keep every entry forever.
   */
  retention_days?: number | null;
}

/** `backend_config` once every knob has been validated and defaulted. */
export interface ResolvedConfig {
  url: string;
  connectTimeoutMs: number;
  prefix: string;
  blockMs: number;
  retentionDays?: number;
}

/**
 * Validate and default the whole of `backend_config`, ahead of any teardown and naming the plugin
 * and the key, so that a value an operator got wrong never leaves a live bridge with no client.
 */
export function resolveConfig(cfg: RedisBackendConfig): ResolvedConfig {
  assertKnownKeys(cfg as Record<string, unknown>);
  return {
    url: normalizeUrl(cfg.url, DEFAULT_URL),
    prefix: normalizeString('key_prefix', cfg.key_prefix, DEFAULT_KEY_PREFIX),
    retentionDays: normalizeRetentionDays(cfg.retention_days),
    blockMs: normalizeMillis('block_ms', cfg.block_ms, DEFAULT_BLOCK_MS),
    connectTimeoutMs: normalizeMillis(
      'connect_timeout_ms',
      cfg.connect_timeout_ms,
      DEFAULT_CONNECT_TIMEOUT_MS,
    ),
  };
}

/** Render a rejected config value for an operator; `JSON.stringify` alone turns NaN into `null`. */
function describeValue(value: unknown): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value) ?? String(value);
}

/**
 * Reject a key `backend_config` does not declare, so that `retention_dayz` or `keyprefix` cannot be
 * accepted in silence and take the DEFAULT behaviour: history kept forever, or a keyspace no peer
 * session shares while every field still reads as consistent.
 */
function assertKnownKeys(cfg: Record<string, unknown>): void {
  for (const key of Object.keys(cfg)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `parley-redis: unknown backend_config key '${key}' — expected one of ` +
          `${CONFIG_KEYS.join(', ')}`,
      );
    }
  }
}

/**
 * Keep the empty-string and wrong-type rejections, so that an unexpanded `"${REDIS_URL}"` cannot
 * fall through to node-redis' default and point the whole bridge at an unauthenticated
 * `127.0.0.1:6379`, nor a non-string `key_prefix` template-coerce into a keyspace (`[object
 * Object]parley:`) no peer session shares. `null` means "omitted" (DESIGN §11).
 */
function normalizeString(key: string, value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `parley-redis: ${key} must be a non-empty string (got ${describeValue(value)}); ` +
        `omit it for the default '${fallback}'`,
    );
  }
  return value;
}

/**
 * Keep the parse and scheme check here rather than leaving them to node-redis' constructor, so that
 * a mistyped URL is rejected by `connect()` instead of escaping as a bare `TypeError: Invalid URL`
 * from deep inside a live plugin. Keep the hostname requirement too: `redis://` parses and carries
 * the right scheme, and would otherwise take node-redis' own default — the same fall-through to an
 * unauthenticated `127.0.0.1:6379` the empty-string rejection exists for. Keep the value itself out
 * of every message: a password in a mistyped URL must never reach a log line, and the scheme is the
 * one part safe to echo back.
 */
function normalizeUrl(value: unknown, fallback: string): string {
  const url = normalizeString('url', value, fallback);
  const reject = (why: string): never => {
    throw new Error(`parley-redis: url must ${why}; omit it for the default '${fallback}'`);
  };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return reject('be a URL of the form redis://host:port (it did not parse)');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    return reject(`use the redis: or rediss: scheme (got '${parsed.protocol}')`);
  }
  if (parsed.hostname === '') return reject(`name a host (got '${parsed.protocol}' and none)`);
  return url;
}

/**
 * Every millisecond knob reaches a place where a nonsensical value is SILENT rather than loud:
 * `block_ms` becomes an `XREAD BLOCK` argument, where `-1`/`0.5`/`NaN` make the server reject every
 * read — killing live push behind a `subscribe()` that resolved — and `0` blocks forever;
 * `connect_timeout_ms` becomes a deadline, where `0` fails every connect against a healthy server.
 */
function normalizeMillis(key: string, value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `parley-redis: ${key} must be a positive whole number of milliseconds ` +
        `(got ${describeValue(value)}); omit it for the default ${fallback}`,
    );
  }
  return value;
}

/**
 * `retention_days` is multiplied into a destructive `XADD MINID` threshold, so every unusable value
 * must be rejected rather than coerced: `0`/negative silently delete history (or every entry,
 * forever, as it lands), a value past the epoch makes the threshold negative so every `post`
 * throws, and a string/NaN produces an invalid stream id. `null` means "omitted" (DESIGN §11).
 */
function normalizeRetentionDays(value: number | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const maxDays = Math.floor(Date.now() / 86_400_000);
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maxDays) {
    throw new Error(
      `parley-redis: retention_days must be a positive number of days no greater than ${maxDays} ` +
        `(got ${describeValue(value)}); omit it (or set null) to keep every entry forever`,
    );
  }
  return value;
}
