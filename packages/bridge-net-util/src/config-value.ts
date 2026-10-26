import { sanitizeBody } from './redact.js';

/** What a value IS, carrying nothing of what it holds. */
export function describeConfigShape(value: unknown): string {
  if (value === '') return 'the empty string';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/**
 * The `backend_config` keys a rejected value is rendered BY CONTENT for, each with why printing it
 * is safe. Everything else is described by SHAPE.
 *
 * Stated as an allowlist rather than as a list of credential-ish substrings, so that a key nobody
 * has classified is LESS INFORMATIVE rather than disclosing. The substring form defaulted an
 * unknown key to "render it", and `nkey_seed`, `creds_file`, `ca_file`, `dsn`, `conn_str`,
 * `bearer`, `api_key`, `signing_key`, `private_key_pem`, `webhook`, `cookie`, `session`,
 * `credentials`, `pwd` and `pat` all fell straight through it — two of them keys this repo declares
 * today. This value reaches an operator's log and the model context core renders a seam error into,
 * so an unrecognised key erring toward silence is the direction that cannot cost a credential.
 */
export const RENDERED_BY_VALUE: Readonly<Record<string, string>> = {
  block_ms: 'a duration in milliseconds; the refusal is about the number',
  connect_timeout_ms: 'a duration in milliseconds; the refusal is about the number',
  handshake_timeout_ms: 'a duration in milliseconds; the refusal is about the number',
  rotation_grace_ms: 'a duration in milliseconds; the refusal is about the number',
  sync_timeout_ms: 'a duration in milliseconds; the refusal is about the number',
  poll_interval_ms: 'a duration in milliseconds; the refusal is about the number',
  poll_timeout_s: 'a duration in seconds; the refusal is about the number',
  retention_days: 'a window in days; the refusal is about the number',
  pool_size: 'a connection count; the refusal is about the number',
  mam_page: 'a page size; the refusal is about the number',
  limit: 'a page size; the refusal is about the number',
  observed_retention_per_chat: 'a retained-record count; the refusal is about the number',
  observed_retention_per_topic: 'a retained-record count; the refusal is about the number',
  observed_max_chats: 'a retained-chat count; the refusal is about the number',
  key_prefix: 'a namespace prefix an operator has to see to correct it',
  table_name: 'a relation name an operator has to see to correct it',
  subject_prefix: 'a namespace prefix an operator has to see to correct it',
  stream_prefix: 'a namespace prefix an operator has to see to correct it',
  room_preset: 'one of a closed set of preset names',
  domain: 'a JID part; the refusal is about which characters are in it',
  muc_service: 'a JID part; the refusal is about which characters are in it',
  username: 'a JID part; the refusal is about which characters are in it',
  nick: 'a JID resource; the refusal is about which characters are in it',
};

/**
 * A caller's value as text, or its SHAPE when it has none. Keep the whole render inside the catch,
 * so that a value whose own rendering THROWS — a circular structure the YAML parser will build from
 * an anchor, a bigint, a null-prototype object, a `toJSON`/`toString` that refuses or raises — is
 * still refused by `connect()` as the plugin's own labelled error, rather than escaping as the bare
 * multi-line `TypeError` (or the caller's own thrown message, unsanitised) that the guards around it
 * exist to keep out of an operator's log and the model context core renders a seam error into.
 *
 * Keep `JSON.stringify` for PRIMITIVES ONLY, so that a container is never ENUMERATED: whatever key
 * a secret was nested under, describing the wrapper cannot print what it wraps.
 */
function render(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'symbol') return describeConfigShape(value);
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    return describeConfigShape(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return describeConfigShape(value);
  }
}

/**
 * Render a rejected `backend_config` value for an operator; `JSON.stringify` alone turns NaN into
 * `null`. Bounded and flattened, so that a value nobody in this repo authored cannot forge line
 * structure in the error core renders into model context.
 */
export function describeConfigValue(key: string, value: unknown): string {
  if (!Object.hasOwn(RENDERED_BY_VALUE, key)) return describeConfigShape(value);
  return sanitizeBody(render(value));
}
