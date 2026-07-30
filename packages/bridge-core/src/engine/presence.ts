/**
 * Presence — the "who is reachable" roster derived ABOVE the seam (no seam change).
 *
 * Each Parley bridge announces itself by POSTING presence messages (hello / heartbeat /
 * goodbye) to ONE shared presence topic (`presence.topic`, default `parley-presence`). Each beat
 * carries the emitter's subscribed topics AND its `post_topics` reach (the regex sources it may
 * post to but does not subscribe) AND a fresh per-process `instanceId`, so `parley_list_users` can
 * report who is reachable per topic AND decide who is a viable hand-off partner in EITHER direction
 * (I can post to a topic they subscribe to, or they can post — per their advertised patterns — to a
 * topic I subscribe to), while a human only has to mute a SINGLE topic on a real chat backend. The
 * roster is REACHABILITY-first: it reconstructs from `fetchRecent` over that one topic and surfaces
 * peers ONLINE now (fresh beat within the TTL window) as well as ones seen recently but currently
 * offline — a post to an offline peer's topic lands durably and it catches up on next start. Because
 * this uses only `post`/`fetchRecent`, it works IDENTICALLY on every backend and needs no new seam
 * method (DESIGN §4/§7).
 *
 * The presence topic is isolated: it is NEVER subscribed (live push) and NEVER enters catch-up /
 * `seen` / read-state, so heartbeats never pollute a real topic's durable history or surface as
 * `<channel>` events. It is also reserved — no `post`/`fetch_recent` (or `post_topics` pattern)
 * may target it. That reservation binds the AGENT-FACING TOOL SURFACE only: it stops a
 * prompt-injected agent from writing beats through Parley. It is NOT an authenticity control —
 * anyone holding write credentials for the bus reaches the presence topic directly, below this
 * seam. A roster entry's handle is SELF-REPORTED by the beat (the seam does not require a backend
 * to carry the posting identity at all, and on a bot-token backend every session's beats arrive
 * under one bot handle), so it is a reachability label, never proof of who is behind it.
 * Cryptographic or ACL-backed roster authenticity is out of scope for v1.
 */
import { asHandle, type Handle, type Message } from '../message.js';
import { isRedosSafeSource, MAX_MATCH_INPUT } from '../regex-safety.js';

/**
 * The single presence topic every bridge announces itself on, unless overridden by
 * `presence.topic`. Must be a legal topic on every backend (Matrix room alias / NATS subject
 * charset, etc.). Keep it consistent across a deployment — bridges with different presence
 * topics cannot see each other in `parley_list_users`.
 */
export const DEFAULT_PRESENCE_TOPIC = 'parley-presence';

/**
 * Cap the topics (and, independently, the post-pattern sources) a single record may advertise —
 * a hostile peer can't bloat the roster or hand us an unbounded pattern list (DESIGN §14). Applied
 * at decode per BEAT and again to the union {@link computeRoster} folds across a handle's instances:
 * a per-beat cap alone does not compose, because one writer mints as many `instanceId`s as it likes.
 */
export const MAX_RECORD_TOPICS = 64;

/**
 * Cap the instances of ONE handle a roster entry folds. Each instance contributes its own capped
 * topics/postTopics, and the number of instances is attacker-chosen (a fresh `instanceId` per beat),
 * so this is what stops the per-beat caps from being multiplied by the presence page size — both in
 * roster memory / `parley_list_users` output and in the untrusted patterns `filterReachable` compiles
 * (DESIGN §14). The freshest-beating instances are the ones kept.
 */
export const MAX_HANDLE_INSTANCES = 8;

/**
 * Cap the length of an untrusted `instanceId` we retain — a hostile beat can't hand us an
 * unbounded string to bloat the roster's per-instance map (DESIGN §14). A real id is a UUID.
 */
export const MAX_INSTANCE_ID_LEN = 128;

/**
 * Cap the length of an untrusted self-reported `handle` we retain — it becomes a roster key, so an
 * unbounded string would bloat the roster map and `parley_list_users` output (DESIGN §14).
 */
export const MAX_HANDLE_LEN = 128;

/**
 * Cap the length of each untrusted topic/post-pattern string a record may advertise (DESIGN §14).
 * The count cap ({@link MAX_RECORD_TOPICS}) bounds how MANY entries a beat carries; this bounds how
 * LONG each one is, so a hostile beat can't smuggle multi-megabyte strings into roster memory and
 * `parley_list_users` output. A real topic name / regex source is short.
 */
export const MAX_TOPIC_LEN = 512;

/**
 * Tolerance (ms) for an emitter's self-reported wall-clock running AHEAD of ours. A beat whose `at`
 * is further in the future than this is REJECTED at {@link decodePresence} (when the roster's real
 * `nowMs` is threaded in) rather than trusted — it never enters the roster. The untrusted `at` drives
 * both TTL freshness (`nowMs - at < ttlMs`) and the recency sort, so a far-future value would
 * otherwise read as permanently "live" and pin a phantom peer at the top of the roster forever, immune
 * to the `sinceMs`/`online_only` gates. Clamping `at` to `nowMs` instead does NOT fix this —
 * it re-clamps to the live now on every evaluation, so the age stays 0 and the phantom is always live;
 * the beat must be dropped, not clamped. ~5 min mirrors typical OIDC `clock_skew` handling; genuine
 * clock skew is far smaller, so legitimate beats are unaffected.
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
  /**
   * The emitting bridge's own handle. The seam does NOT require a backend to carry the posting
   * identity — a bot-token backend delivers every session's beats under one bot handle — so the
   * roster keys on this self-reported value and falls back to `Message.senderHandle` only for a
   * pre-`handle` beat. Untrusted like every other field (see the module header): it is a
   * reachability label, not an authenticity claim.
   */
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
   * clobbered by the old process's trailing `goodbye` (the bug this scopes out). `''` is the
   * "anonymous instance" sentinel an old beat (which omits the field) decodes to — collapsing to
   * the previous per-handle behaviour, so mixed-version fleets degrade gracefully.
   */
  instanceId: string;
}

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

/** Encode a presence record for the `content` field of a presence message. */
export function encodePresence(rec: PresenceRecord): string {
  return JSON.stringify(rec);
}

/**
 * Decode a presence message's `content`. Returns null for anything that isn't a well-formed
 * presence record — defensive against a stray or spoofed message on the presence topic
 * (inbound is untrusted; DESIGN §14). A pre-v2 record (the old per-topic scheme) decodes to
 * null: those live on old derived topics the current reader never fetches.
 *
 * When `nowMs` is supplied ({@link computeRoster} threads in the roster's real clock), a beat whose
 * self-reported `at` is more than {@link MAX_CLOCK_SKEW_MS} in the future is REJECTED — an untrusted
 * far-future clock must never enter the roster, where it would read as permanently "live" and pin a
 * phantom peer online forever. A pure decode (no `nowMs`, e.g. round-trip tests) leaves `at`
 * unbounded.
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
  // The self-reported clock is untrusted. Drop a beat whose `at` is implausibly far in the
  // future (beyond a small skew tolerance) so it can never enter the roster and be counted "live" —
  // clamping `at` to now would instead re-read it as freshly-live on every evaluation (age 0).
  if (nowMs !== undefined && r.at > nowMs + MAX_CLOCK_SKEW_MS) return null;
  if (!Array.isArray(r.topics) || !r.topics.every((t) => typeof t === 'string' && t.length > 0)) {
    return null;
  }
  // Truncate rather than reject: a fresh beat with an over-long list is still useful liveness. Drop
  // (don't truncate — that would fabricate a different topic name) any per-string over MAX_TOPIC_LEN
  // before the count cap, so a hostile beat can't bloat roster memory / tool output.
  const topics = (r.topics as string[]).filter((t) => t.length <= MAX_TOPIC_LEN).slice(0, MAX_RECORD_TOPICS);
  // `postTopics` is optional/additive: absent (old emitter) or malformed ⇒ [] rather than a
  // whole-record reject — the liveness signal is still worth keeping. Same count + per-string caps.
  const postTopics =
    Array.isArray(r.postTopics) && r.postTopics.every((t) => typeof t === 'string' && t.length > 0)
      ? (r.postTopics as string[]).filter((t) => t.length <= MAX_TOPIC_LEN).slice(0, MAX_RECORD_TOPICS)
      : [];
  // `instanceId` is optional/additive: absent (old emitter) or malformed ⇒ '' (the anonymous
  // instance, i.e. today's per-handle collapse) rather than a whole-record reject.
  const instanceId = typeof r.instanceId === 'string' && r.instanceId.length > 0 ? r.instanceId : '';
  // `handle` is optional/additive: absent (old emitter) or malformed ⇒ undefined, and the roster
  // falls back to the backend's sender attribution.
  const handle = typeof r.handle === 'string' && r.handle.length > 0 ? r.handle : undefined;
  // Both become roster MAP KEYS, so drop the whole record (don't truncate — that would fabricate a
  // different identity and merge two peers, or two instances, into one slot) when either is over
  // its cap. This is the policy the list fields above already apply to an over-long member.
  if (instanceId.length > MAX_INSTANCE_ID_LEN) return null;
  if (handle !== undefined && handle.length > MAX_HANDLE_LEN) return null;
  return { v: 2, kind: r.kind, at: r.at, handle, topics, postTopics, instanceId };
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
 * memory, `parley_list_users` output, and the regex compiler in {@link filterReachable}.
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
 * `messages` are pre-sorted ascending by cursor (the plugin's ordering guarantee, DESIGN §6), so
 * the LAST record per `(handle, instanceId)` is that instance's latest beat. The handle comes from
 * the RECORD ({@link emitterOf}), not from `Message.senderHandle`: a backend is free not to carry
 * the posting identity, and on those every session's beats would otherwise collapse into one
 * phantom peer. Liveness is scoped PER INSTANCE: a handle is `online` iff ANY of its instances has a
 * latest beat that is `hello`/`heartbeat` (not `goodbye`) AND fresh (`nowMs - at < ttlMs`). Keying
 * per instance means a `goodbye` from an exiting process reaps only THAT process's slot — a
 * relaunch's fresh instance (new random `instanceId`) is never clobbered by the old process's
 * trailing `goodbye`. TTL is the real liveness gate — it reclaims crashed instances that never sent
 * a `goodbye`.
 *
 * An OFFLINE handle (no live instance) is still surfaced — a post to its topic lands durably and it
 * catches up on next start, so it is a valid hand-off target — as long as it was last seen within
 * `sinceMs`; older handles are dropped. `online` is independent of `sinceMs` (a live handle always
 * appears). A handle's advertised `topics`/`postTopics` are the union across its live instances
 * when online, or the single last-known beat when offline — bounded by {@link MAX_HANDLE_INSTANCES}
 * instances ({@link retainFreshest} chooses which) and {@link MAX_RECORD_TOPICS} unioned entries,
 * because the number of instances one writer mints is untrusted. Entries sort most-recently-seen
 * first so the freshest hand-off candidates lead (online naturally floats up).
 */
export function computeRoster(messages: Message[], nowMs: number, opts: RosterOptions): RosterEntry[] {
  const byHandle = new Map<Handle, Map<string, PresenceRecord>>();
  for (const m of messages) {
    // Thread `nowMs` so decode drops an untrusted far-future `at` (beyond MAX_CLOCK_SKEW_MS) before it
    // ever reaches the liveness/recency logic below — legitimate small skew still decodes.
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
    // Every record here already has a trusted-enough `at`: decode rejected any beat more than
    // MAX_CLOCK_SKEW_MS in the future, so a spoofed far-future beat never reaches this point
    // and cannot read as "live" or dominate the recency sort. Legitimate within-skew beats are kept.
    const live = recs.filter((r) => r.kind !== 'goodbye' && nowMs - r.at < opts.ttlMs);
    const online = live.length > 0;
    // Keep this a reduce rather than `Math.max(...)`: the argument count would be the instance count,
    // which a plugin returning a page longer than the requested limit chooses, and a spread of that
    // many arguments throws RangeError instead of producing a roster.
    const lastSeenMs = recs.reduce((max, r) => (r.at > max ? r.at : max), Number.NEGATIVE_INFINITY);
    if (!online && nowMs - lastSeenMs >= opts.sinceMs) continue; // offline & too stale ⇒ drop
    // Topics/reach: union across live instances when online; the single last-known beat when offline.
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
  return roster;
}

/**
 * Max length of an untrusted peer post-pattern source we will compile. A beat's `postTopics` are
 * attacker-controlled regex sources (inbound is untrusted, DESIGN §14). This length cap and the
 * per-record count cap ({@link MAX_RECORD_TOPICS} at decode) bound how MUCH a hostile beat can carry
 * — they do NOT bound backtracking: a 20-char nested-quantifier source such as `((([a-z-]+)+)+)+[0-9]`
 * hangs Node's single-threaded engine for seconds against even a short 15-char topic. The
 * backtracking bound is {@link isRedosSafeSource}, applied before we ever compile a source.
 */
const MAX_PEER_PATTERN_LEN = 512;


/**
 * Compile a peer's advertised `postTopics` sources into full-match regexes (`^(?:src)$`, mirroring
 * the Allowlist). Each source is length-capped ({@link MAX_PEER_PATTERN_LEN}), screened for
 * catastrophic backtracking ({@link isRedosSafeSource}), and wrapped in a `try/catch`; any source
 * that is over-long, screens as unsafe, or fails to compile is skipped — so a hostile beat can never
 * crash or hang `parley_list_users`.
 */
function compilePeerPatterns(sources: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const src of sources) {
    if (src.length > MAX_PEER_PATTERN_LEN) continue;
    if (!isRedosSafeSource(src)) continue; // reject catastrophic-backtracking sources up front
    try {
      out.push(new RegExp(`^(?:${src})$`));
    } catch {
      // Un-compilable source from an untrusted peer — ignore it.
    }
  }
  return out;
}

/**
 * Test compiled untrusted patterns against a bounded prefix of `input` (our topic names are short;
 * clamping the compared string keeps even a screened, low-degree match cheap regardless of input).
 */
function reachesBounded(patterns: readonly RegExp[], input: string): boolean {
  const bounded = input.length > MAX_MATCH_INPUT ? input.slice(0, MAX_MATCH_INPUT) : input;
  return patterns.some((re) => re.test(bounded));
}

/**
 * The pure hand-off REACHABILITY predicate behind `parley_list_users` (DESIGN §7): given a roster
 * and the caller's own reach, keep only the peers that share a viable channel.
 *
 *  - **Scoped** (`opts.scope` set): a peer is included iff it subscribes to that topic OR one of its
 *    advertised `postTopics` patterns matches it.
 *  - **Unscoped**: a peer is included iff we share a channel in EITHER direction — I can post to a
 *    topic it subscribes to (`opts.canPostTo`), OR it can post — per its advertised patterns — to a
 *    topic I subscribe to (`opts.mySubscribedTopics`).
 *
 * Peer `postTopics` are untrusted regex sources; {@link compilePeerPatterns} length-caps them,
 * screens out catastrophic-backtracking sources ({@link isRedosSafeSource}), and full-match-anchors
 * whatever survives, and {@link reachesBounded} then tests them against only a bounded prefix of the
 * caller's own topic names — so a hostile beat cannot wedge the loop. Passing
 * `canPostTo`/`mySubscribedTopics` as plain values/predicates keeps `engine/` free of any dependency
 * on `Allowlist`.
 */
export function filterReachable(
  roster: RosterEntry[],
  opts: {
    /** A specific topic to scope to, or undefined for the bidirectional unscoped roster. */
    scope?: string;
    /** Whether the caller may post to a topic — pass `allow.has`. */
    canPostTo: (topic: string) => boolean;
    /** The caller's own subscribed topics — pass `allow.topics()`. */
    mySubscribedTopics: readonly string[];
  },
): RosterEntry[] {
  return roster.filter((e) => {
    if (opts.scope !== undefined) {
      return (
        e.topics.includes(opts.scope) ||
        reachesBounded(compilePeerPatterns(e.postTopics), opts.scope)
      );
    }
    if (e.topics.some((t) => opts.canPostTo(t))) return true;
    const theirReach = compilePeerPatterns(e.postTopics);
    return opts.mySubscribedTopics.some((mt) => reachesBounded(theirReach, mt));
  });
}
