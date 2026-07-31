/**
 * The hand-off REACHABILITY predicate behind `parley_list_users` (DESIGN §7): given a roster and the
 * caller's own reach, keep the peers that share a viable channel. Peer `postTopics` are untrusted
 * regex sources, so everything here is written against a hostile source AND a hostile count of them.
 */
import { isRedosSafeSource, MAX_MATCH_INPUT } from '../regex-safety.js';
import type { RosterEntry } from './presence.js';

/**
 * Max length of an untrusted peer post-pattern source we will compile. This and the per-record count
 * cap bound how MUCH a hostile beat can carry — they do NOT bound backtracking: a 20-char
 * nested-quantifier source such as `((([a-z-]+)+)+)+[0-9]` hangs Node's single-threaded engine for
 * seconds against even a short 15-char topic. {@link isRedosSafeSource} is the backtracking bound.
 */
const MAX_PEER_PATTERN_LEN = 512;

/**
 * Whole-call ceiling (ms) on the untrusted peer-pattern work ONE {@link filterReachable} spends.
 * {@link isRedosSafeSource} bounds what a single screened match costs — per source, leaving the
 * caller to bound how many it holds. Here the count is `entries × their advertised patterns × the
 * caller's own topics`, and the first two factors are chosen by whoever writes the beats, so the
 * per-source bound alone multiplies out to seconds of synchronous CPU on a page of legal beats. Node
 * is single-threaded: that time is the whole bridge, long-polls and heartbeats included.
 */
const PEER_PATTERN_BUDGET_MS = 50;

/**
 * The peer-pattern matcher for ONE {@link filterReachable} call. Keep the compile full-match
 * anchored (`^(?:src)$`, mirroring the Allowlist), so that a peer advertising `ops` cannot reach
 * `my-ops-secret`. Input is clamped to a bounded prefix because our topic names are short, which
 * keeps even a screened, low-degree match cheap. Past the deadline a peer is simply not matched BY
 * PATTERN — it still surfaces on a topic it explicitly advertises, so the degradation drops reach,
 * never safety.
 */
function peerReach(): (sources: readonly string[], input: string) => boolean {
  const deadline = Date.now() + PEER_PATTERN_BUDGET_MS;
  const compiled = new Map<string, RegExp | null>();
  const compile = (src: string): RegExp | null => {
    const cached = compiled.get(src);
    if (cached !== undefined) return cached;
    let re: RegExp | null = null;
    if (src.length <= MAX_PEER_PATTERN_LEN && isRedosSafeSource(src)) {
      try {
        re = new RegExp(`^(?:${src})$`);
      } catch {
        re = null; // un-compilable source from an untrusted peer
      }
    }
    compiled.set(src, re);
    return re;
  };
  return (sources, input) => {
    const bounded = input.length > MAX_MATCH_INPUT ? input.slice(0, MAX_MATCH_INPUT) : input;
    for (const src of sources) {
      if (Date.now() >= deadline) return false;
      const re = compile(src);
      if (re !== null && re.test(bounded)) return true;
    }
    return false;
  };
}

/**
 * Keep only the roster entries the caller shares a channel with.
 *
 *  - **Scoped** (`opts.scope` set): a peer is included iff it subscribes to that topic OR one of its
 *    advertised `postTopics` patterns matches it.
 *  - **Unscoped**: a peer is included iff we share a channel in EITHER direction — I can post to a
 *    topic it subscribes to (`opts.canPostTo`), OR it can post — per its advertised patterns — to a
 *    topic I subscribe to (`opts.mySubscribedTopics`).
 *
 * Passing `canPostTo`/`mySubscribedTopics` as plain values/predicates keeps `engine/` free of any
 * dependency on `Allowlist`.
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
  const reaches = peerReach();
  return roster.filter((e) => {
    if (opts.scope !== undefined) {
      return e.topics.includes(opts.scope) || reaches(e.postTopics, opts.scope);
    }
    if (e.topics.some((t) => opts.canPostTo(t))) return true;
    return opts.mySubscribedTopics.some((mt) => reaches(e.postTopics, mt));
  });
}
