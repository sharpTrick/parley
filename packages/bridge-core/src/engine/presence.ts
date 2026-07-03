/**
 * Presence — "who is live" derived ABOVE the seam (no seam change).
 *
 * Each Parley bridge announces itself by POSTING presence messages (hello / heartbeat /
 * goodbye) to a derived presence topic — the mechanical shadow of a real allowlisted topic.
 * `parley_list_users` then reconstructs the live roster from `fetchRecent` over those presence
 * topics plus a liveness window (TTL). Because this uses only `post`/`fetchRecent`, it works
 * IDENTICALLY on every backend and needs no new seam method (DESIGN §4/§7).
 *
 * Presence topics are isolated: they are NEVER subscribed (live push) and NEVER enter
 * catch-up / `seen` / read-state, so heartbeats never pollute a real topic's durable history
 * or surface as `<channel>` events.
 */
import { asTopic, type Handle, type Message, type Topic } from '../message.js';

/**
 * Reserved suffix appended to a real topic to derive its presence topic. Topics ending in this
 * suffix are reserved for presence and must not be used as real topics.
 *
 * The derived string must be a legal topic on every backend (Matrix room alias / NATS subject
 * charset, etc.). This is the ONE place the scheme is defined — adjust here if a backend rejects
 * it (e.g. switch separators) rather than special-casing anywhere else.
 */
export const PRESENCE_TOPIC_SUFFIX = '-parley-presence';

/** Derive the presence topic that shadows a real topic. */
export function presenceTopicFor(topic: Topic): Topic {
  return asTopic(`${topic}${PRESENCE_TOPIC_SUFFIX}`);
}

/** The kind of a presence beat. `goodbye` is a best-effort fast-path removal (TTL is the real gate). */
export type PresenceKind = 'hello' | 'heartbeat' | 'goodbye';

/** The payload carried in a presence message's `content` (JSON). Versioned for forward-compat. */
export interface PresenceRecord {
  v: 1;
  kind: PresenceKind;
  /** Emitter wall-clock (ms) when the beat was sent — used for TTL freshness (advisory; DESIGN §14). */
  at: number;
}

/** A live participant surfaced by {@link computeLive}. */
export interface LiveEntry {
  handle: Handle;
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
 * (inbound is untrusted; DESIGN §14).
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
  if (r.v !== 1) return null;
  if (r.kind !== 'hello' && r.kind !== 'heartbeat' && r.kind !== 'goodbye') return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  return { v: 1, kind: r.kind, at: r.at };
}

/**
 * Reconstruct the live roster from one presence topic's messages.
 *
 * `messages` are pre-sorted ascending by cursor (the plugin's ordering guarantee, DESIGN §6), so
 * the LAST record per handle is its latest. A handle is live iff its latest beat is
 * `hello`/`heartbeat` (not `goodbye`) AND is fresh (`nowMs - at < ttlMs`). TTL is the real
 * liveness gate — it reclaims crashed instances that never sent a `goodbye`.
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
    live.push({ handle, lastSeenMs: rec.at });
  }
  live.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  return live;
}
