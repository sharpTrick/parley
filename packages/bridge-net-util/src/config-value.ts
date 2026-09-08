import { sanitizeBody } from './redact.js';

/** What a value IS, carrying nothing of what it holds. */
export function describeConfigShape(value: unknown): string {
  if (value === '') return 'the empty string';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/**
 * A caller's value as text, or its SHAPE when it has none. Keep the whole render inside the catch,
 * so that a value whose own rendering THROWS — a circular structure the YAML parser will build from
 * an anchor, a bigint, a null-prototype object, a `toJSON`/`toString` that refuses or raises — is
 * still refused by `connect()` as the plugin's own labelled error, rather than escaping as the bare
 * multi-line `TypeError` (or the caller's own thrown message, unsanitised) that the guards around it
 * exist to keep out of an operator's log and the model context core renders a seam error into.
 */
function render(value: unknown): string {
  if (typeof value === 'number') return String(value);
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
 *
 * Keep a value that names a URL out of a message entirely — pass it to {@link describeConfigShape}
 * instead — so that a password in a mistyped URL never reaches a log line.
 */
export function describeConfigValue(value: unknown): string {
  return sanitizeBody(render(value));
}
