import { sanitizeBody } from './redact.js';

/** What a value IS, carrying nothing of what it holds. */
export function describeConfigShape(value: unknown): string {
  if (value === '') return 'the empty string';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/**
 * Substrings of a `backend_config` key whose value is, or can contain, a credential. Matched on the
 * KEY rather than on the value, so that such a value is described by shape whatever type it arrives
 * as: the branch that rejects one reads `not a non-empty string`, which admits every container a
 * secret can be nested inside.
 */
const CREDENTIAL_CARRIERS = ['pass', 'secret', 'token', 'auth', 'url', 'key_file', 'cert'];

const carriesCredential = (key: string): boolean => {
  const lower = key.toLowerCase();
  return CREDENTIAL_CARRIERS.some((part) => lower.includes(part));
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
  if (carriesCredential(key)) return describeConfigShape(value);
  return sanitizeBody(render(value));
}
