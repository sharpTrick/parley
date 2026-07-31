/**
 * The presence beat: the wire record a bridge posts to the shared presence topic, and the caps that
 * make decoding it safe.
 *
 * A beat is inbound data like any other message and is UNTRUSTED (DESIGN §14). The handle it carries
 * is self-reported — the seam does not require a backend to carry the posting identity, and on a
 * bot-token backend every session's beats arrive under one bot handle — so it is a reachability
 * label, never proof of who is behind it. Cryptographic or ACL-backed roster authenticity is out of
 * scope for v1.
 */

/**
 * The single presence topic every bridge announces itself on, unless overridden by
 * `presence.topic`. Must be a legal topic on every backend (Matrix room alias / NATS subject
 * charset, etc.). Keep it consistent across a deployment — bridges with different presence
 * topics cannot see each other in `parley_list_users`.
 */
export const DEFAULT_PRESENCE_TOPIC = 'parley-presence';

/**
 * Cap the topics (and, independently, the post-pattern sources) a single record may advertise, so a
 * hostile peer cannot bloat the roster or hand us an unbounded pattern list (DESIGN §14). Re-applied
 * to the union a roster entry folds across a handle's instances: a per-beat cap alone does not
 * compose, because one writer mints as many `instanceId`s as it likes.
 */
export const MAX_RECORD_TOPICS = 64;

/**
 * Cap the length of an untrusted `instanceId` we retain — it becomes a per-instance map key, and an
 * unbounded string would bloat roster memory (DESIGN §14). A real id is a UUID.
 */
export const MAX_INSTANCE_ID_LEN = 128;

/**
 * Cap the length of an untrusted self-reported `handle` we retain — it becomes a roster key, so an
 * unbounded string would bloat the roster map and `parley_list_users` output (DESIGN §14).
 */
export const MAX_HANDLE_LEN = 128;

/**
 * Cap the length of each untrusted topic/post-pattern string a record may advertise (DESIGN §14).
 * {@link MAX_RECORD_TOPICS} bounds how MANY a beat carries; this bounds how LONG each one is, so a
 * hostile beat cannot smuggle multi-megabyte strings into roster memory and `parley_list_users`
 * output. A real topic name / regex source is short.
 */
export const MAX_TOPIC_LEN = 512;

/**
 * Tolerance (ms) for an emitter's self-reported wall-clock running AHEAD of ours. A beat further in
 * the future than this is REJECTED at {@link decodePresence} rather than trusted, so it never enters
 * the roster: the untrusted `at` drives both TTL freshness and the recency sort, so a far-future
 * value would otherwise read as permanently "live" and pin a phantom peer at the top of the roster
 * forever, immune to the `sinceMs`/`online_only` gates. Keep the beat DROPPED rather than clamping
 * `at` to `nowMs`, so that the phantom cannot survive: a clamp re-clamps on every evaluation, so the
 * age stays 0 and the peer is always live. ~5 min mirrors typical OIDC `clock_skew` handling;
 * genuine clock skew is far smaller, so legitimate beats are unaffected.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** The kind of a presence beat. `goodbye` is a best-effort fast-path removal (TTL is the real gate). */
export type PresenceKind = 'hello' | 'heartbeat' | 'goodbye';

/**
 * The payload carried in a presence message's `content` (JSON). Versioned for forward-compat.
 *
 * `v: 2` carries THREE additive fields — `postTopics`, `instanceId` and `handle` — each added
 * WITHOUT a version bump: older beats omit them and decode with `postTopics: []` /
 * `instanceId: ''` / no `handle`; older readers ignore them. Bumping `v` would make old readers
 * reject new beats mid-rollout — additive keeps mixed-version fleets interoperable (DESIGN §7).
 */
export interface PresenceRecord {
  v: 2;
  kind: PresenceKind;
  /** Emitter wall-clock (ms) when the beat was sent — used for TTL freshness (advisory; DESIGN §14). */
  at: number;
  /** The emitting bridge's own handle. Absent on a beat emitted before the field existed. */
  handle?: string;
  /** The emitter's explicit subscribed topics at beat time (its `topics` allowlist). */
  topics: string[];
  /**
   * The emitter's `post_topics` reach: the raw regex SOURCES it may post to but does NOT subscribe
   * to (§14). A reader treats these as UNTRUSTED and compiles them defensively — never enumerated
   * (a pattern can match infinitely many topics), matched against the reader's own topics instead.
   */
  postTopics: string[];
  /**
   * A fresh PER-PROCESS token (a random id minted at loop start), NOT the config-stable
   * `instance_id`. Liveness is derived per `(handle, instanceId)` so a `goodbye` from an exiting
   * process reaps only its OWN instance — a relaunch mints a new id, so its `hello` is never
   * clobbered by the old process's trailing `goodbye`. `''` is the "anonymous instance" sentinel an
   * old beat (which omits the field) decodes to — collapsing to the previous per-handle behaviour,
   * so mixed-version fleets degrade gracefully.
   */
  instanceId: string;
}

/** Encode a presence record for the `content` field of a presence message. */
export function encodePresence(rec: PresenceRecord): string {
  return JSON.stringify(rec);
}

/**
 * Decode a presence message's `content`, or null for anything that is not a well-formed v2 record —
 * defensive against a stray or spoofed message on the presence topic (DESIGN §14). A pre-v2 record
 * decodes to null: those live on old derived topics the current reader never fetches.
 *
 * `nowMs` (threaded in by the roster) enables the {@link MAX_CLOCK_SKEW_MS} rejection; a pure decode
 * without it leaves `at` unbounded.
 */
export function decodePresence(content: string, nowMs?: number): PresenceRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (r.v !== 2) return null;
  if (r.kind !== 'hello' && r.kind !== 'heartbeat' && r.kind !== 'goodbye') return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  if (nowMs !== undefined && r.at > nowMs + MAX_CLOCK_SKEW_MS) return null;
  if (!Array.isArray(r.topics) || !r.topics.every((t) => typeof t === 'string' && t.length > 0)) {
    return null;
  }
  // Truncate rather than reject: a fresh beat with an over-long list is still useful liveness. Keep
  // an over-long member DROPPED rather than truncated, so that no different topic name is fabricated.
  const topics = (r.topics as string[]).filter((t) => t.length <= MAX_TOPIC_LEN).slice(0, MAX_RECORD_TOPICS);
  // `postTopics` is optional/additive: absent (old emitter) or malformed ⇒ [] rather than a
  // whole-record reject — the liveness signal is still worth keeping. Same count + per-string caps.
  const postTopics =
    Array.isArray(r.postTopics) && r.postTopics.every((t) => typeof t === 'string' && t.length > 0)
      ? (r.postTopics as string[]).filter((t) => t.length <= MAX_TOPIC_LEN).slice(0, MAX_RECORD_TOPICS)
      : [];
  // `instanceId` and `handle` are optional/additive too: absent or malformed ⇒ the anonymous
  // instance / the backend's sender attribution, not a whole-record reject.
  const instanceId = typeof r.instanceId === 'string' && r.instanceId.length > 0 ? r.instanceId : '';
  const handle = typeof r.handle === 'string' && r.handle.length > 0 ? r.handle : undefined;
  // Both become MAP KEYS, so keep an over-long one REJECTING the record rather than truncated, so
  // that a truncation cannot fabricate an identity and merge two peers, or two instances, into one.
  if (instanceId.length > MAX_INSTANCE_ID_LEN) return null;
  if (handle !== undefined && handle.length > MAX_HANDLE_LEN) return null;
  return { v: 2, kind: r.kind, at: r.at, handle, topics, postTopics, instanceId };
}
