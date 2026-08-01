import type { Topic } from '@sharptrick/parley-core';

export function badConfig(key: string, reason: string): Error {
  return new Error(`parley-postgres: invalid backend_config.${key} — ${reason}`);
}

export function unknownConfigKey(key: string, allowed: readonly string[]): Error {
  return new Error(
    `parley-postgres: unknown backend_config key '${key}' — expected one of ${allowed.join(', ')}`,
  );
}

/** The largest value PostgreSQL's `bigint` holds — the ceiling on any cursor this backend mints. */
const MAX_SEQ = 9223372036854775807n;

/**
 * Reject a `since` this backend cannot have minted, before it reaches `seq > $2::bigint`. `since`
 * is opaque and agent-supplied, and the cast decides what happens to anything else: `'abc'` raises
 * SQLSTATE 22P02 into agent context, while `' 5 '`, `'0x10'` and `'-1'` are quietly accepted
 * because bigint input is laxer than a cursor.
 */
export function assertCursor(since: string): void {
  if (!/^\d{1,19}$/.test(since) || BigInt(since) > MAX_SEQ) {
    throw new Error(
      `parley-postgres: invalid cursor ${JSON.stringify(since)} — a cursor from this backend is a ` +
        `decimal sequence number between 0 and ${MAX_SEQ}. Pass one this backend returned as ` +
        '`nextCursor`, or omit `since` to get the newest page.',
    );
  }
}

/** Locates the offending code unit for the message below; the refusal itself is decided by UTF-8. */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Refuse a seam argument this backend cannot store as given, before it reaches the driver. Every
 * one of these is agent- or human-supplied and untrusted (DESIGN §5), and both hazards below are
 * ordinary characters to JSON and to JavaScript. A NUL byte PostgreSQL answers with a bare driver
 * string naming neither this plugin, nor the field, nor the fact that nothing was written. An
 * unpaired surrogate is worse, because nothing fails at all: the driver encodes it as U+FFFD, so
 * two topics a `post_topics` pattern admits as distinct silently share one history, two handles
 * collapse onto one `_senders` row, and `content` is read back altered.
 *
 * Keep the second rule stated as "does this survive a UTF-8 round trip", so that the next shape
 * UTF-8 cannot carry is refused without anyone having to think of it first.
 */
export function assertStorable(field: string, value: string): void {
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new Error(
      `parley-postgres: invalid ${field} — an unpaired surrogate at index ` +
        `${value.search(UNPAIRED_SURROGATE)} has no UTF-8 encoding, so PostgreSQL would store ` +
        'U+FFFD in its place and this value would not be the one read back. Nothing was written; ' +
        'repair or strip it and retry.',
    );
  }
  const at = value.indexOf('\u0000');
  if (at < 0) return;
  throw new Error(
    `parley-postgres: invalid ${field} — a NUL byte (U+0000) at index ${at} cannot be stored in ` +
      "PostgreSQL's TEXT type. Nothing was written; strip it and retry.",
  );
}

/**
 * Wrap EVERY way `subscribe` can fail so the seam call names this plugin and the topic it was for.
 * Core's push loop rethrows anything that is not a `NoSuchTopicError`, so a raw driver string from
 * any of the statements `subscribe` runs stops the whole bridge coming up on a message naming
 * neither the backend nor the topic.
 */
export function subscribeFailed(topic: Topic, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  if (detail.startsWith('parley-postgres:')) return err as Error;
  return new Error(
    `parley-postgres: could not establish the live path for topic '${topic}' — ${detail}. Nothing ` +
      'was registered for that topic; a retry succeeds once the database is reachable again.',
  );
}

/**
 * How long a statement waits for a server-side lock before giving up, in ms. Every lock this
 * plugin takes is held for one INSERT or one idempotent bootstrap, so reaching this means another
 * session is sitting on it. Keep a bound here, so that a wedged lock cannot pin a pooled
 * connection forever and starve every other seam call of pool capacity.
 */
export const LOCK_WAIT_MS = 5000;

/** PostgreSQL's SQLSTATE for a statement that gave up waiting on a lock (`lock_timeout`). */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Name a lock wait this plugin abandoned. Without the rename it reaches the agent as PostgreSQL's
 * bare 'canceling statement due to lock timeout', naming neither the plugin, the topic, nor the
 * fact that nothing was written.
 */
export function lockWaitAbandoned(what: string, err: unknown): Error {
  if ((err as { code?: string } | undefined)?.code !== LOCK_NOT_AVAILABLE) return err as Error;
  return new Error(
    `parley-postgres: gave up after ${LOCK_WAIT_MS}ms waiting for the ${what} — another session is ` +
      'holding it. Nothing was written; retry once that session commits or is terminated.',
  );
}
