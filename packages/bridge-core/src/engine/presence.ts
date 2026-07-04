/**
 * Presence — "who is live" derived ABOVE the seam (no seam change).
 *
 * Each Parley bridge announces itself by POSTING presence messages (hello / heartbeat /
 * goodbye) to ONE shared presence topic (`presence.topic`, default `parley-presence`). Each beat
 * carries the emitter's subscribed topics AND its `post_topics` reach (the regex sources it may
 * post to but does not subscribe), so `parley_list_users` can report who is live per topic AND
 * decide who is a viable hand-off partner in EITHER direction (I can post to a topic they
 * subscribe to, or they can post — per their advertised patterns — to a topic I subscribe to),
 * while a human only has to mute a SINGLE topic on a real chat backend. The roster is
 * reconstructed from `fetchRecent` over that one topic plus a liveness window (TTL). Because this
 * uses only `post`/`fetchRecent`, it works IDENTICALLY on every backend and needs no new seam
 * method (DESIGN §4/§7).
 *
 * The presence topic is isolated: it is NEVER subscribed (live push) and NEVER enters catch-up /
 * `seen` / read-state, so heartbeats never pollute a real topic's durable history or surface as
 * `<channel>` events. It is also reserved — no `post`/`fetch_recent` (or `post_topics` pattern)
 * may target it, so a peer cannot spoof the roster.
 */
import type { Handle, Message } from '../message.js';

/**
 * The single presence topic every bridge announces itself on, unless overridden by
 * `presence.topic`. Must be a legal topic on every backend (Matrix room alias / NATS subject
 * charset, etc.). Keep it consistent across a deployment — bridges with different presence
 * topics cannot see each other in `parley_list_users`.
 */
export const DEFAULT_PRESENCE_TOPIC = 'parley-presence';

/**
 * Cap the topics (and, independently, the post-pattern sources) a single record may advertise —
 * a hostile peer can't bloat the roster or hand us an unbounded pattern list (DESIGN §14).
 */
export const MAX_RECORD_TOPICS = 64;

/** The kind of a presence beat. `goodbye` is a best-effort fast-path removal (TTL is the real gate). */
export type PresenceKind = 'hello' | 'heartbeat' | 'goodbye';

/**
 * The payload carried in a presence message's `content` (JSON). Versioned for forward-compat.
 *
 * `postTopics` was added as an ADDITIVE field on `v: 2` (not a version bump): older beats omit it
 * and decode with `postTopics: []`; older readers ignore it. Bumping `v` would make old readers
 * reject new beats mid-rollout — additive keeps mixed-version fleets interoperable.
 */
export interface PresenceRecord {
  v: 2;
  kind: PresenceKind;
  /** Emitter wall-clock (ms) when the beat was sent — used for TTL freshness (advisory; DESIGN §14). */
  at: number;
  /** The emitter's explicit subscribed topics at beat time (its `topics` allowlist). */
  topics: string[];
  /**
   * The emitter's `post_topics` reach: the raw regex SOURCES it may post to but does NOT subscribe
   * to (§14). A reader treats these as UNTRUSTED and compiles them defensively — never enumerated
   * (a pattern can match infinitely many topics), matched against the reader's own topics instead.
   */
  postTopics: string[];
}

/** A live participant surfaced by {@link computeLive}. */
export interface LiveEntry {
  handle: Handle;
  /** The subscribed topics advertised by this handle's latest beat. */
  topics: string[];
  /** The `post_topics` regex sources advertised by this handle's latest beat (post-only reach). */
  postTopics: string[];
  /** The `at` of this handle's latest beat (ms). */
  lastSeenMs: number;
}

/** Encode a presence record for the `content` field of a presence message. */
export function encodePresence(rec: PresenceRecord): string {
  return JSON.stringify(rec);
}

/**
 * Decode a presence message's `content`. Returns null for anything that isn't a well-formed
 * presence record — defensive against a stray or spoofed message on the presence topic
 * (inbound is untrusted; DESIGN §14). A pre-v2 record (the old per-topic scheme) decodes to
 * null: those live on old derived topics the current reader never fetches.
 */
export function decodePresence(content: string): PresenceRecord | null {
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
  if (!Array.isArray(r.topics) || !r.topics.every((t) => typeof t === 'string' && t.length > 0)) {
    return null;
  }
  // Truncate rather than reject: a fresh beat with an over-long list is still useful liveness.
  const topics = (r.topics as string[]).slice(0, MAX_RECORD_TOPICS);
  // `postTopics` is optional/additive: absent (old emitter) or malformed ⇒ [] rather than a
  // whole-record reject — the liveness signal is still worth keeping. Same cap as `topics`.
  const postTopics =
    Array.isArray(r.postTopics) && r.postTopics.every((t) => typeof t === 'string' && t.length > 0)
      ? (r.postTopics as string[]).slice(0, MAX_RECORD_TOPICS)
      : [];
  return { v: 2, kind: r.kind, at: r.at, topics, postTopics };
}

/**
 * Reconstruct the live roster from the presence topic's messages.
 *
 * `messages` are pre-sorted ascending by cursor (the plugin's ordering guarantee, DESIGN §6), so
 * the LAST record per handle is its latest. A handle is live iff its latest beat is
 * `hello`/`heartbeat` (not `goodbye`) AND is fresh (`nowMs - at < ttlMs`). TTL is the real
 * liveness gate — it reclaims crashed instances that never sent a `goodbye`. The handle's
 * advertised `topics` come from that same latest beat.
 */
export function computeLive(messages: Message[], nowMs: number, ttlMs: number): LiveEntry[] {
  const latest = new Map<Handle, PresenceRecord>();
  for (const m of messages) {
    const rec = decodePresence(m.content);
    if (rec === null) continue;
    latest.set(m.senderHandle, rec); // ascending cursor order ⇒ last write wins
  }
  const live: LiveEntry[] = [];
  for (const [handle, rec] of latest) {
    if (rec.kind === 'goodbye') continue;
    if (nowMs - rec.at >= ttlMs) continue;
    live.push({ handle, topics: rec.topics, postTopics: rec.postTopics, lastSeenMs: rec.at });
  }
  live.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  return live;
}
