import type { Topic } from '@sharptrick/parley-core';

/**
 * The one error this package raises that is not an answer from a server. Keep it named here rather
 * than spelled at the throw site, so that {@link serverRefused} can tell a caller's own mistake
 * apart from a statement the database refused.
 */
export const NOT_CONNECTED = 'PostgresPlugin not connected — call connect() first';

export function badConfig(key: string, reason: string): Error {
  return new Error(`parley-postgres: invalid backend_config.${key} — ${reason}`);
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

/**
 * `BTMaxItemSize` on PostgreSQL's default 8 KiB page: the largest index row a btree will take.
 * Keep this measured against a live server rather than read off a manual, so that a deployment
 * whose real ceiling differs is caught here instead of by an agent holding a bare SQLSTATE 54000.
 */
export const BTREE_MAX_ITEM_BYTES = 2704;

/**
 * What a btree index row spends on everything that is not the value: the `IndexTupleData` header
 * (8), the varlena header a long TEXT key carries (4), and the trailing `seq` key of the
 * `(topic, seq)` index (8). Budgeted for the WIDEST of this schema's indexes, so that one number
 * is safe for every field below.
 */
const INDEX_TUPLE_OVERHEAD_BYTES = 20;

/** The longest a value this backend puts in a btree key may be, in UTF-8 bytes. */
export const MAX_INDEXED_BYTES = BTREE_MAX_ITEM_BYTES - INDEX_TUPLE_OVERHEAD_BYTES;

/**
 * The seam fields this backend stores in a btree key — `topic` through `<table>_topic_seq`, `handle`
 * through `<table>_senders`'s primary key. `content`, `sender` and `in_reply_to` are indexed by
 * nothing and the server holds megabytes of any of them. Keep this set derived from `buildSchema`
 * by the suite rather than agreed by hand, so that an index added to another column narrows the
 * screen with it.
 */
export const INDEXED_FIELDS: ReadonlySet<string> = new Set(['topic', 'handle']);

/** Locates the offending code unit for the message below; the refusal itself is decided by UTF-8. */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Refuse a seam argument this backend cannot store as given, before it reaches the driver. Every
 * one of these is agent- or human-supplied and untrusted (DESIGN §5), and every hazard below looks
 * ordinary to JSON and to JavaScript. A NUL byte PostgreSQL answers with a bare driver string
 * naming neither this plugin, nor the field, nor the fact that nothing was written. An oversized
 * `topic` or `handle` is answered the same way, and worse across calls: `subscribe()` never touches
 * a btree key, so without this screen it registers a live path for a topic every `post()` refuses.
 * An unpaired surrogate is worst, because nothing fails at all: the driver encodes it as U+FFFD, so
 * two topics a `post_topics` pattern admits as distinct silently share one history, two handles
 * collapse onto one `_senders` row, and `content` is read back altered.
 *
 * The size screen is deliberately blind to compression: PostgreSQL compresses an index key before
 * measuring it, so a long repetitive topic the server would have taken is refused here. Keep it
 * blind, so that whether a topic is usable is a property of the topic and not of how well it
 * happened to compress — and so post, fetchRecent and subscribe never disagree about one.
 *
 * Keep the second rule stated as "does this survive a UTF-8 round trip", so that the next shape
 * UTF-8 cannot carry is refused without anyone having to think of it first.
 */
export function assertStorable(field: string, value: string): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (INDEXED_FIELDS.has(field) && bytes > MAX_INDEXED_BYTES) {
    throw new Error(
      `parley-postgres: invalid ${field} — ${bytes} bytes exceeds the ${MAX_INDEXED_BYTES}-byte ` +
        `budget for a value this backend carries in a btree index key. Nothing was written; ` +
        'shorten it and retry.',
    );
  }
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
 * Name a dial this plugin abandoned. A peer that completes the TCP handshake and then never speaks
 * — a firewalled port, a stalled pooler, a primary mid-failover — is the one failure that reaches
 * an operator as nothing at all: `connect()` is the first call any bridge makes, so the MCP host
 * sees a server that never initialises and no diagnostic anywhere.
 */
export function dialAbandoned(what: string, budgetMs: number): Error {
  return new Error(
    `parley-postgres: gave up on ${what} after ${budgetMs}ms — the connection was accepted but ` +
      'the server never answered. Nothing was created or written; check that backend_config.url ' +
      'points at a reachable PostgreSQL rather than a firewalled port or a stalled pooler.',
  );
}

/**
 * How long a statement waits for a server-side lock before giving up, in ms. Every lock this
 * plugin takes is held for one INSERT or one idempotent bootstrap, so reaching this means another
 * session is sitting on it. Keep a bound here, so that a wedged lock cannot pin a pooled
 * connection forever and starve every other seam call of pool capacity.
 */
export const LOCK_WAIT_MS = 5000;

/** pg's message when `query_timeout` fires — the driver's only spelling for it. */
const QUERY_READ_TIMEOUT = 'Query read timeout';

/**
 * Did this statement fail because the ANSWER never came back — a half-open socket, a black-holing
 * pooler — rather than because the server said no? The two demand opposite handling of the
 * connection underneath, so keep the question asked in one place.
 */
export function answerNeverCame(err: unknown): boolean {
  return (err as { message?: string } | undefined)?.message === QUERY_READ_TIMEOUT;
}

/**
 * Name a statement this plugin gave up on for that reason. Without the rename it reaches agent
 * context as the driver's bare 'Query read timeout', naming neither the plugin, the operation, nor
 * the fact that nothing was written.
 */
export function answerAbandoned(what: string, budgetMs: number, err: unknown): Error {
  if (!answerNeverCame(err)) return err as Error;
  return new Error(
    `parley-postgres: gave up on ${what} after ${budgetMs}ms — the connection is open but the ` +
      'server stopped answering. Nothing was written; that connection has been discarded and a ' +
      'retry opens a new one.',
  );
}

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

/**
 * The driver's own text, to the OPERATOR. PostgreSQL's message quotes the deployment — its relation
 * names, and for a dial failure the host and port it could not reach — and a rejected seam call is
 * rendered into the model's context by core's tools.ts, so an untrusted conversation would carry
 * the schema and the network topology behind the bridge. Keep the text going SOMEWHERE, so that
 * removing it from the answer does not leave a permission error or a filled disk reaching nobody at
 * all: this plugin logs nothing else.
 */
function toOperator(what: string, detail: string): void {
  console.error(`[parley-postgres] ${what} failed — ${detail}`);
}

/**
 * The server's own classification of a refusal, and the only part of an error this plugin hands
 * back verbatim. A SQLSTATE ('42P01') or a Node dial code ('ECONNREFUSED') is a fixed vocabulary an
 * operator can look up; every other field the driver fills in is written from the deployment.
 */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code !== '' ? ` (${code})` : '';
}

/**
 * Name a server refusal this plugin never anticipated. {@link answerAbandoned} and
 * {@link lockWaitAbandoned} each rename ONE shape and hand everything else back untouched, so every
 * other SQLSTATE — a permission the role does not have, a filled disk, a relation dropped under a
 * live pool, an index key the server would not take — reaches agent context as a bare PostgreSQL
 * string naming neither this plugin nor the operation. Keep this OUTSIDE the two renames above, so
 * that adding a third cannot leave a gap.
 *
 * Keep the answer built from a CODE rather than from the driver's message, so that what the caller
 * gets cannot depend on which identifiers PostgreSQL happened to quote in the shape it hit.
 */
export function serverRefused(what: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  if (detail === NOT_CONNECTED || detail.startsWith('parley-postgres:')) return err as Error;
  toOperator(what, detail);
  return new Error(
    `parley-postgres: ${what} failed — the database refused it${codeOf(err)}. Nothing was ` +
      "written; the driver's own text is on this process's stderr for the operator, and a retry " +
      'succeeds once the condition it names is cleared.',
  );
}
