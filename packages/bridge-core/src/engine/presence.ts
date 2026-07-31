/**
 * Presence — the "who is reachable" roster derived ABOVE the seam (no seam change).
 *
 * Each Parley bridge announces itself by POSTING beats (hello / heartbeat / goodbye) to ONE shared
 * presence topic (`presence.topic`), each carrying its subscribed topics, its `post_topics` reach
 * and a fresh per-process `instanceId`. `parley_list_users` reconstructs the roster from
 * `fetchRecent` over that one topic, so a human only has to mute a SINGLE topic on a real chat
 * backend and the whole feature works IDENTICALLY on every backend with no new seam method
 * (DESIGN §4/§7). It is REACHABILITY-first: peers ONLINE now and peers seen recently but currently
 * offline both surface, because a post to an offline peer's topic lands durably and it catches up on
 * next start.
 *
 * The presence topic is isolated: it is NEVER subscribed (live push) and NEVER enters catch-up /
 * `seen` / read-state, so heartbeats never pollute a real topic's durable history or surface as
 * `<channel>` events. It is also reserved — no `post`/`fetch_recent` (or `post_topics` pattern)
 * may target it. That reservation binds the AGENT-FACING TOOL SURFACE only: it stops a
 * prompt-injected agent from writing beats through Parley. It is NOT an authenticity control —
 * anyone holding write credentials for the bus reaches the presence topic directly, below this seam.
 *
 * This module folds decoded beats into the roster; `presence-beat.ts` owns the wire record and
 * `presence-reach.ts` the reachability predicate applied to the result.
 */
import { asHandle, type Handle, type Message } from '../message.js';
import { decodePresence, MAX_RECORD_TOPICS, type PresenceRecord } from './presence-beat.js';

export * from './presence-beat.js';
export { filterReachable } from './presence-reach.js';

/**
 * Cap the instances of ONE handle a roster entry folds. Each instance contributes its own capped
 * topics/postTopics, and the number of instances is attacker-chosen (a fresh `instanceId` per beat),
 * so without this the per-beat caps would be multiplied by the presence page size WITHIN one entry
 * (DESIGN §14). The freshest-beating instances are the ones kept.
 */
export const MAX_HANDLE_INSTANCES = 8;

/**
 * Cap the ENTRIES a roster carries, freshest-first. Every other cap here is per RECORD or per
 * HANDLE, and the handle a beat reports is self-declared — one writer holding one credential mints
 * as many handles as it has beats — so the record count is the factor that multiplies all of them
 * into `parley_list_users` output and into the untrusted-pattern work `filterReachable` does. The
 * presence page size is not a bound on it: it is a page of an attacker-chosen stream. A caller that
 * fills this cap is told its roster is incomplete, exactly as a full presence page already is.
 */
export const MAX_ROSTER_ENTRIES = 128;

/** A participant in a `parley_list_users` roster — either online now or offline-but-recently-seen. */
export interface RosterEntry {
  handle: Handle;
  /** True iff at least one of this handle's instances has a fresh, non-`goodbye` latest beat. */
  online: boolean;
  /** Subscribed topics: the union across live instances when online; the last-known beat's when offline. */
  topics: string[];
  /** `post_topics` regex sources (post-only reach), sourced the same way as {@link topics}. */
  postTopics: string[];
  /** The freshest beat time (ms) heard from this handle, of any kind — drives recency sort + window. */
  lastSeenMs: number;
}

/** The two liveness windows the roster computation applies. */
export interface RosterOptions {
  /** Online cutoff: an instance is live iff its latest non-`goodbye` beat is newer than this (ms). */
  ttlMs: number;
  /** Offline inclusion cutoff: an offline handle is surfaced iff it was last seen within this window (ms). */
  sinceMs: number;
}

/**
 * Which handle a beat belongs to. The seam does not require a backend to carry the posting identity
 * (a bot-token backend delivers every session's beats under ONE bot handle), so the record's
 * self-reported `handle` leads and `senderHandle` is the compatibility fallback for a beat emitted
 * before the field existed.
 */
function emitterOf(rec: PresenceRecord, m: Message): Handle {
  return rec.handle === undefined ? m.senderHandle : asHandle(rec.handle);
}

/** Which of two beats loses its instance slot first: a `goodbye` before any live beat, then the older. */
function evictedBefore(a: PresenceRecord, b: PresenceRecord): boolean {
  const aGone = a.kind === 'goodbye';
  const bGone = b.kind === 'goodbye';
  return aGone === bGone ? a.at < b.at : aGone;
}

/**
 * Record a handle's latest beat per instance, keeping at most {@link MAX_HANDLE_INSTANCES} of them.
 *
 * Keep eviction ranked by the BEAT ({@link evictedBefore}), never by arrival order: a handle whose
 * sessions churn faster than its heartbeat posts a run of short-lived instances after a long-lived
 * one, and evicting by arrival drops the live instance and reports a reachable peer offline.
 */
function retainFreshest(insts: Map<string, PresenceRecord>, rec: PresenceRecord): void {
  insts.set(rec.instanceId, rec);
  while (insts.size > MAX_HANDLE_INSTANCES) {
    let evictId = '';
    let evict: PresenceRecord | undefined;
    for (const [id, r] of insts) {
      if (evict === undefined || evictedBefore(r, evict)) {
        evictId = id;
        evict = r;
      }
    }
    insts.delete(evictId);
  }
}

/**
 * Union one untrusted string field across the instances feeding a roster entry, re-applying
 * {@link MAX_RECORD_TOPICS} to the RESULT. This is where the per-beat caps stop composing: without
 * it, `instances × MAX_RECORD_TOPICS × MAX_TOPIC_LEN` bytes of one writer's strings reach roster
 * memory, `parley_list_users` output, and the regex compiler behind `filterReachable`.
 */
function unionCapped(from: readonly PresenceRecord[], pick: (r: PresenceRecord) => string[]): string[] {
  const out = new Set<string>();
  for (const rec of from) {
    for (const value of pick(rec)) {
      out.add(value);
      if (out.size >= MAX_RECORD_TOPICS) return [...out];
    }
  }
  return [...out];
}

/**
 * Reconstruct the reachability roster from the presence topic's messages (DESIGN §7).
 *
 * `messages` are pre-sorted ascending by cursor (the plugin's ordering guarantee, DESIGN §6), so the
 * LAST record per `(handle, instanceId)` is that instance's latest beat. Liveness is scoped PER
 * INSTANCE: a handle is `online` iff ANY of its instances has a latest beat that is
 * `hello`/`heartbeat` (not `goodbye`) AND fresh (`nowMs - at < ttlMs`). Keying per instance means a
 * `goodbye` from an exiting process reaps only THAT process's slot — a relaunch's fresh instance is
 * never clobbered by the old process's trailing `goodbye`. TTL is the real liveness gate: it
 * reclaims crashed instances that never sent a `goodbye`.
 *
 * `online` is independent of `sinceMs`: a live handle always appears. A handle's advertised
 * `topics`/`postTopics` are the union across its live instances when online, or the single
 * last-known beat when offline.
 */
export function computeRoster(messages: Message[], nowMs: number, opts: RosterOptions): RosterEntry[] {
  const byHandle = new Map<Handle, Map<string, PresenceRecord>>();
  for (const m of messages) {
    // Keep `nowMs` threaded into the decode, so that an untrusted far-future `at` is dropped before
    // it can reach the liveness/recency logic below and read as permanently live.
    const rec = decodePresence(m.content, nowMs);
    if (rec === null) continue;
    const emitter = emitterOf(rec, m);
    let insts = byHandle.get(emitter);
    if (insts === undefined) {
      insts = new Map();
      byHandle.set(emitter, insts);
    }
    retainFreshest(insts, rec);
  }
  const roster: RosterEntry[] = [];
  for (const [handle, insts] of byHandle) {
    const recs = [...insts.values()];
    const live = recs.filter((r) => r.kind !== 'goodbye' && nowMs - r.at < opts.ttlMs);
    const online = live.length > 0;
    // Keep this a reduce rather than `Math.max(...)`: the argument count would be the instance count,
    // which a plugin returning a page longer than the requested limit chooses, and a spread of that
    // many arguments throws RangeError instead of producing a roster.
    const lastSeenMs = recs.reduce((max, r) => (r.at > max ? r.at : max), Number.NEGATIVE_INFINITY);
    if (!online && nowMs - lastSeenMs >= opts.sinceMs) continue;
    const from = online ? live : [recs.reduce((a, b) => (b.at >= a.at ? b : a))];
    roster.push({
      handle,
      online,
      topics: unionCapped(from, (r) => r.topics),
      postTopics: unionCapped(from, (r) => r.postTopics),
      lastSeenMs,
    });
  }
  // Most-recently-seen first; handle asc as a stable tiebreak for determinism.
  roster.sort(
    (a, b) => b.lastSeenMs - a.lastSeenMs || (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0),
  );
  return roster.slice(0, MAX_ROSTER_ENTRIES);
}
