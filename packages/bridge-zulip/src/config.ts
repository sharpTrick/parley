import type { BackendConfig } from '@sharptrick/parley-core';
import type { ZulipBackendConfig } from './index.js';

const DEFAULT_SITE_URL = 'http://127.0.0.1:9991';
const DEFAULT_EMAIL = 'parley-bot@localhost';
const DEFAULT_API_KEY = 'parley-api-key';
const DEFAULT_STREAM = 'parley';

/**
 * Bounds on the effective long-poll cap. Keep the floor, so that no `events_timeout_ms` a config can
 * carry leaves the push loop polling with no cap at all. What it bounds is the SHAPE of the idle
 * load and not its affordability: a cap is spent twice over — parked poll, then liveness probe — for
 * each subscribed topic, which puts the floor an order of magnitude above the request budget a
 * default Zulip gives a bot. The README's config table carries that arithmetic for the operator.
 */
const MIN_EVENTS_TIMEOUT_MS = 250;
const MAX_EVENTS_TIMEOUT_MS = 600_000;
const DEFAULT_EVENTS_TIMEOUT_MS = 25_000;

/** A validated `backend_config`: every value the plugin puts on the wire, plus what to warn about. */
export interface ZulipConfig {
  baseUrl: string;
  email: string;
  apiKey: string;
  stream: string;
  eventsTimeoutMs: number;
  usesDefaultApiKey: boolean;
}

/**
 * Zulip auth is per-request HTTP Basic (`email:api_key`) — there is no session or token to
 * establish, so this is all `connect` has to do. Every value that could otherwise fail late (an
 * unusable `site_url`, an empty `stream`) or fail silently (an `events_timeout_ms` that makes the
 * push loop hot) is rejected here, naming the offending key. Keep the unknown-key check first, so
 * that a mistyped key is reported ahead of any value it could be confused with.
 */
export function resolveConfig(config: BackendConfig): ZulipConfig {
  const cfg = config as ZulipBackendConfig;
  assertKnownKeys(cfg);
  return {
    baseUrl: requireHttpUrl(orDefault(cfg.site_url, DEFAULT_SITE_URL)),
    email: requireNonEmpty('email', orDefault(cfg.email, DEFAULT_EMAIL)),
    apiKey: requireNonEmpty('api_key', orDefault(cfg.api_key, DEFAULT_API_KEY), true),
    stream: requireStreamName(orDefault(cfg.stream, DEFAULT_STREAM)),
    eventsTimeoutMs: requireEventsTimeout(cfg.events_timeout_ms),
    usesDefaultApiKey: cfg.api_key === undefined || cfg.api_key === DEFAULT_API_KEY,
  };
}

/**
 * Keep this narrower than `??`, so that a key present in the config but EMPTY (a bare `site_url:`
 * in YAML is `null`) is reported rather than silently replaced by the built-in default.
 */
function orDefault<T>(value: T | undefined, fallback: T): T | undefined {
  return value === undefined ? fallback : value;
}

/**
 * Every key {@link ZulipBackendConfig} declares. Keep the `satisfies` on it, so that a key added to
 * the interface without being listed here is a compile error rather than a key `connect()` rejects.
 */
const CONFIG_KEYS = Object.keys({
  site_url: 0,
  email: 0,
  api_key: 0,
  stream: 0,
  events_timeout_ms: 0,
} satisfies Record<keyof Required<ZulipBackendConfig>, 0>);

/**
 * Reject a key `backend_config` does not declare, before any value is read. Keep it a load error,
 * so that a mistyped `api_kye` cannot fall through to the built-in default credential, nor a
 * mistyped `events_timeout` leave the poll cap at a value the operator believes they replaced.
 */
function assertKnownKeys(cfg: object): void {
  for (const key of Object.keys(cfg)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw new Error(
        `backend_config: unknown key '${key}' — expected one of ${CONFIG_KEYS.join(', ')}`,
      );
    }
  }
}

/**
 * `site_url` must be usable as a base URL now, not at first request — and must be a base URL and
 * nothing else. A credential in it is REFUSED rather than carried: Zulip authenticates from
 * `email`/`api_key`, secret hygiene keys on the config key NAME (`site_url` is not a secret one),
 * and an accepted value's origin is echoed by the plaintext warning. A query or fragment is refused
 * for the same fail-fast reason it would break every request path.
 *
 * Keep every rejection here reported by SHAPE, so that no part of a mis-pasted credential reaches
 * stderr and model context: the requirement plus the key name is the whole diagnostic for a URL,
 * while a bare secret is an unparseable URL and one carrying a `:` is a URL whose SCHEME is the
 * secret's first token.
 */
function requireHttpUrl(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `backend_config.site_url must be an absolute http(s) URL (got ${describeShape(raw)})`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `backend_config.site_url must use http: or https: (got ${describeShape(raw)} carrying ` +
        'some other scheme)',
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      'backend_config.site_url must not carry a username or password: Zulip authenticates from ' +
        'backend_config.email/api_key, and a credential in the URL is disclosed by every ' +
        'diagnostic that names the site. Remove the userinfo from site_url.',
    );
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(
      'backend_config.site_url must be a bare base URL: a query or fragment is appended to every ' +
        'request path and can hide a credential in a key hygiene treats as non-secret.',
    );
  }
  return trimmed;
}

/**
 * `secret: true` reports the offending SHAPE instead of the value. Keep it on for every credential,
 * so that a mistyped `api_key` (a bare number in YAML) is not echoed into stderr and the tool
 * result core hands the model.
 */
function requireNonEmpty(key: string, value: unknown, secret = false): string {
  if (typeof value !== 'string' || value.trim() === '') {
    const got = secret ? describeShape(value) : describeRejected(value, 'string');
    throw new Error(`backend_config.${key} must be a non-empty string (got ${got})`);
  }
  return value;
}

/**
 * What Zulip's `to` would address instead of the stream NAMED by this value, or `undefined` when it
 * addresses that stream. `zerver/lib/recipient_parsing.py::extract_stream_indicator` decodes `to` as
 * JSON first and only falls back to a raw name, so a digits-only name is a stream ID and a quoted or
 * single-element-list name is the name inside it — while the read and register narrows send the same
 * string as a NAME either way. Reported by KIND rather than by value: a name that happens to be
 * valid JSON is exactly the shape a mis-pasted numeric credential arrives in.
 */
function streamIndicatorTarget(stream: string): string | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stream);
  } catch {
    return undefined;
  }
  if (typeof decoded === 'number') return 'a stream ID';
  if (typeof decoded === 'string') return 'a differently quoted stream name';
  if (Array.isArray(decoded)) return 'a stream name wrapped in a JSON list';
  return 'a JSON literal Zulip refuses as a send target';
}

/**
 * A stream name the server will not re-interpret, or a throw naming what it would do with it: a
 * write that addresses a different stream from the read narrow reports a durable message id for a
 * message no `fetchRecent` on that topic can ever return.
 */
function requireStreamName(value: unknown): string {
  const stream = requireNonEmpty('stream', value);
  const target = streamIndicatorTarget(stream);
  if (target !== undefined) {
    throw new Error(
      'backend_config.stream must be a plain stream name: Zulip decodes the send target as a ' +
        `stream indicator, so this one would address ${target} on every write while every read ` +
        'narrows on the literal name. Rename the stream.',
    );
  }
  return stream;
}

/**
 * The rejected value itself, or its SHAPE when its type is not the one the key declares. Keep the
 * wrong-type arm on the shape, so that a mis-pasted credential is not echoed into stderr by a key
 * whose NAME secret hygiene classifies as harmless.
 */
function describeRejected(value: unknown, declared: 'string' | 'number'): string {
  return typeof value === declared ? JSON.stringify(value) : describeShape(value);
}

/** Enough of a value to debug the wrong shape, never enough to disclose it. */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'string') return `a ${value.length}-character string`;
  return `a ${typeof value}`;
}

/**
 * The effective long-poll cap. A non-positive or non-numeric value is rejected outright; a usable
 * one is clamped, so that neither a sub-millisecond value nor one past the timer's 32-bit range can
 * make each poll return instantly and turn the loop into a silent request flood.
 */
function requireEventsTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_EVENTS_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      'backend_config.events_timeout_ms must be a positive, finite number of milliseconds ' +
        `(got ${describeRejected(value, 'number')})`,
    );
  }
  return Math.min(Math.max(value, MIN_EVENTS_TIMEOUT_MS), MAX_EVENTS_TIMEOUT_MS);
}
