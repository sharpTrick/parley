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

/**
 * Cap the length of an untrusted `instanceId` we retain — a hostile beat can't hand us an
 * unbounded string to bloat the roster's per-instance map (DESIGN §14). A real id is a UUID.
 */
export const MAX_INSTANCE_ID_LEN = 128;

/** The kind of a presence beat. `goodbye` is a best-effort fast-path removal (TTL is the real gate). */
export type PresenceKind = 'hello' | 'heartbeat' | 'goodbye';

/**
 * The payload carried in a presence message's `content` (JSON). Versioned for forward-compat.
 *
 * `v: 2` carries TWO additive fields — `postTopics` and `instanceId` — each added WITHOUT a
 * version bump: older beats omit them and decode with `postTopics: []` / `instanceId: ''`; older
 * readers ignore them. Bumping `v` would make old readers reject new beats mid-rollout — additive
 * keeps mixed-version fleets interoperable (DESIGN §7).
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

/** A participant surfaced by {@link computeRoster} — either online now or offline-but-recently-seen. */
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

/** The two liveness windows {@link computeRoster} applies. */
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
  // `instanceId` is optional/additive: absent (old emitter) or malformed ⇒ '' (the anonymous
  // instance, i.e. today's per-handle collapse) rather than a whole-record reject. Length-capped
  // because it is untrusted (DESIGN §14).
  const instanceId =
    typeof r.instanceId === 'string' && r.instanceId.length > 0
      ? r.instanceId.slice(0, MAX_INSTANCE_ID_LEN)
      : '';
  return { v: 2, kind: r.kind, at: r.at, topics, postTopics, instanceId };
}

/**
 * Reconstruct the reachability roster from the presence topic's messages (DESIGN §7).
 *
 * `messages` are pre-sorted ascending by cursor (the plugin's ordering guarantee, DESIGN §6), so
 * the LAST record per `(handle, instanceId)` is that instance's latest beat. Liveness is scoped
 * PER INSTANCE: a handle is `online` iff ANY of its instances has a latest beat that is
 * `hello`/`heartbeat` (not `goodbye`) AND fresh (`nowMs - at < ttlMs`). Keying per instance means
 * a `goodbye` from an exiting process reaps only THAT process's slot — a relaunch's fresh instance
 * (new random `instanceId`) is never clobbered by the old process's trailing `goodbye`. TTL is the
 * real liveness gate — it reclaims crashed instances that never sent a `goodbye`.
 *
 * An OFFLINE handle (no live instance) is still surfaced — a post to its topic lands durably and it
 * catches up on next start, so it is a valid hand-off target — as long as it was last seen within
 * `sinceMs`; older handles are dropped. `online` is independent of `sinceMs` (a live handle always
 * appears). A handle's advertised `topics`/`postTopics` are the union across its live instances
 * when online, or the single last-known beat when offline. Entries sort most-recently-seen first so
 * the freshest hand-off candidates lead (online naturally floats up).
 */
export function computeRoster(messages: Message[], nowMs: number, opts: RosterOptions): RosterEntry[] {
  const byHandle = new Map<Handle, Map<string, PresenceRecord>>();
  for (const m of messages) {
    const rec = decodePresence(m.content);
    if (rec === null) continue;
    let insts = byHandle.get(m.senderHandle);
    if (insts === undefined) {
      insts = new Map();
      byHandle.set(m.senderHandle, insts);
    }
    insts.set(rec.instanceId, rec); // ascending cursor order ⇒ last write wins per instance
  }
  const roster: RosterEntry[] = [];
  for (const [handle, insts] of byHandle) {
    const recs = [...insts.values()];
    const live = recs.filter((r) => r.kind !== 'goodbye' && nowMs - r.at < opts.ttlMs);
    const online = live.length > 0;
    const lastSeenMs = Math.max(...recs.map((r) => r.at)); // freshest beat of ANY kind
    if (!online && nowMs - lastSeenMs >= opts.sinceMs) continue; // offline & too stale ⇒ drop
    // Topics/reach: union across live instances when online; the single last-known beat when offline.
    const from = online ? live : [recs.reduce((a, b) => (b.at >= a.at ? b : a))];
    roster.push({
      handle,
      online,
      topics: [...new Set(from.flatMap((r) => r.topics))],
      postTopics: [...new Set(from.flatMap((r) => r.postTopics))],
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
 * Most unbounded (`*` / `+` / `{n,}`) quantifiers we allow in one untrusted source. A handful is
 * ample for a real topic pattern; capping the count bounds the polynomial-backtracking degree of even
 * a nesting-free source (sequential `.*.*…`).
 */
const MAX_PEER_PATTERN_QUANTIFIERS = 4;

/**
 * Longest input string we ever feed to an untrusted peer pattern. Our own topic names are short, so
 * clamping the compared string caps the worst-case work of a (screened, low-degree) match no matter
 * how long a self-configured topic is.
 */
const MAX_PEER_MATCH_INPUT = 64;

/**
 * Conservative structural ReDoS screen for an untrusted regex source, run BEFORE compiling it. Node's
 * `RegExp` backtracks, so a hostile source can wedge the whole single-threaded process; catastrophic
 * blowup needs one of two structural shapes and we reject both:
 *   - a quantifier that lets a group whose body itself contains a quantifier or alternation repeat
 *     TWO OR MORE times — the exponential/polynomial signature. This covers an UNBOUNDED outer
 *     quantifier (`(x+)+`, `(a|a)*`, `(x*){2,}`) AND a BOUNDED exact/range count `>= 2` (`(x*){15}`,
 *     `(x?){250}`, `(x+){2,5}`): V8 unrolls `{n}`/`{n,m}` into up to n sequential copies of the risky
 *     body, so a bounded exact count over a `*`/`?`-body is just as catastrophic as an unbounded one
 *     (empirically `([a-z-]*){15}[0-9]` hangs Node for ~8s on a 15-char input). Only a bound of `<= 1`
 *     (`?`, `{0,1}`, `{1}`) is safe, since a body matched at most once cannot compound; or
 *   - more than {@link MAX_PEER_PATTERN_QUANTIFIERS} unbounded quantifiers (`.*.*…`) — a high-degree
 *     polynomial blowup. (Because a risky body repeated `>= 2` times is rejected above, any
 *     multiplicity from unrolling a `{n}` over an unbounded-quantifier body is already excluded — so
 *     the unbounded count here need not itself be scaled by the unroll factor.)
 * Character-class interiors and escaped metacharacters are treated as literal. It is deliberately
 * conservative (it may reject some safe-but-exotic sources); a legitimate topic pattern never needs a
 * nested quantifier. Anything that still slips through as un-compilable is caught by the `try/catch`
 * in {@link compilePeerPatterns}.
 */
function isRedosSafeSource(src: string): boolean {
  let unbounded = 0;
  // Per-open-group flag: did this group's body contain a quantifier or alternation (directly, or
  // inherited from a nested non-quantified subgroup)? A quantified group with a risky body is the
  // catastrophic case. Index 0 is the implicit top level (never itself quantified).
  const risky: boolean[] = [false];
  // Parse a `{...}` quantifier at `i`; null when `{` is a literal brace, not a valid quantifier.
  // `unbounded` = open-ended reps (a comma is present, `{n,}`/`{n,m}`) — preserved for the polynomial
  // count. `max` = the largest repetition the quantifier permits (Infinity when open-ended) — used to
  // decide whether a risky body may repeat `>= 2` times.
  const readBrace = (i: number): { len: number; unbounded: boolean; max: number } | null => {
    const m = /^\{(\d*)(,(\d*))?\}/.exec(src.slice(i));
    if (!m || (m[1] === '' && m[3] === undefined)) return null; // `{}` / bare `{` ⇒ literal
    const min = m[1] === '' ? 0 : Number.parseInt(m[1]!, 10);
    const hasComma = m[2] !== undefined;
    // `{n}` ⇒ exactly n; `{n,}` ⇒ open-ended (Infinity); `{n,m}` ⇒ m; `{,m}` ⇒ m (min defaulted to 0).
    const max = !hasComma ? min : m[3] === '' ? Number.POSITIVE_INFINITY : Number.parseInt(m[3]!, 10);
    return { len: m[0].length, unbounded: hasComma, max };
  };
  for (let i = 0; i < src.length; ) {
    const ch = src[i]!;
    if (ch === '\\') {
      i += 2; // escaped atom ⇒ literal
      continue;
    }
    if (ch === '[') {
      // Character class: everything up to the closing `]` is literal (quantifier chars included).
      i++;
      if (src[i] === '^') i++;
      if (src[i] === ']') i++; // a leading `]` is a literal class member
      while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
      i++; // consume `]`
      continue;
    }
    if (ch === '(') {
      risky.push(false);
      i++;
      continue;
    }
    if (ch === ')') {
      const body = risky.pop() ?? false;
      i++;
      let quantified = false;
      let quantUnbounded = false;
      let quantMax = 1; // reps the group's quantifier permits (1 = none, `?`, `{0,1}`, `{1}` — all safe)
      const q = src[i];
      if (q === '*' || q === '+') {
        quantified = true;
        quantUnbounded = true;
        quantMax = Number.POSITIVE_INFINITY;
        i++;
      } else if (q === '?') {
        quantified = true;
        i++;
      } else if (q === '{') {
        const b = readBrace(i);
        if (b) {
          quantified = true;
          quantUnbounded = b.unbounded;
          quantMax = b.max;
          i += b.len;
        }
      }
      if (quantified && (src[i] === '?' || src[i] === '+')) i++; // lazy / possessive suffix
      // A group with a risky body (its own quantifier or alternation) becomes catastrophic the moment
      // it can repeat TWO OR MORE times — whether the outer quantifier is unbounded (`(x+)+`) OR a
      // bounded exact/range count `>= 2` (`(x*){15}`, `(x?){250}`), which V8 unrolls into sequential
      // copies of the risky body. Reject both; only a bound of `<= 1` (`?`/`{0,1}`/`{1}`) is safe.
      if (body && quantMax >= 2) return false;
      if (quantified && quantUnbounded) unbounded++;
      const parent = risky.length - 1;
      risky[parent] = risky[parent] || body || quantified;
      continue;
    }
    if (ch === '|') {
      risky[risky.length - 1] = true;
      i++;
      continue;
    }
    if (ch === '*' || ch === '+') {
      // Unbounded quantifier on a single preceding atom.
      unbounded++;
      risky[risky.length - 1] = true;
      i++;
      if (src[i] === '?' || src[i] === '+') i++;
      continue;
    }
    if (ch === '?') {
      risky[risky.length - 1] = true;
      i++;
      continue;
    }
    if (ch === '{') {
      const b = readBrace(i);
      if (b) {
        if (b.unbounded) {
          unbounded++;
          risky[risky.length - 1] = true;
        }
        i += b.len;
        if (src[i] === '?') i++; // lazy suffix
        continue;
      }
      i++; // literal brace
      continue;
    }
    i++; // literal char
  }
  return unbounded <= MAX_PEER_PATTERN_QUANTIFIERS;
}

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
  const bounded = input.length > MAX_PEER_MATCH_INPUT ? input.slice(0, MAX_PEER_MATCH_INPUT) : input;
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
