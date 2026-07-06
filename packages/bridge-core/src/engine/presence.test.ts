import { describe, expect, it } from 'vitest';
import { asBackendMsgId, asCursor, asHandle, asTopic, type Message } from '../message.js';
import {
  computeRoster,
  decodePresence,
  encodePresence,
  filterReachable,
  MAX_INSTANCE_ID_LEN,
  MAX_RECORD_TOPICS,
  type PresenceKind,
  type PresenceRecord,
  type RosterEntry,
} from './presence.js';

/** Build a presence Message on the shared presence topic in ascending-cursor order (seq drives the cursor). */
function beat(
  handle: string,
  kind: PresenceKind,
  at: number,
  seq: number,
  topics: string[] = ['ctx'],
  postTopics: string[] = [],
  instanceId = '',
): Message {
  return {
    topic: asTopic('parley-presence'),
    senderHandle: asHandle(handle),
    content: encodePresence({ v: 2, kind, at, topics, postTopics, instanceId }),
    timestamp: new Date(seq * 1000).toISOString(),
    backendMsgId: asBackendMsgId(String(seq)),
    cursor: asCursor(String(seq)),
    mentions: [],
  };
}

describe('encode/decode presence', () => {
  it('round-trips a record, including postTopics and instanceId', () => {
    const rec: PresenceRecord = {
      v: 2,
      kind: 'heartbeat',
      at: 1234,
      topics: ['ctx-a', 'ctx-b'],
      postTopics: ['ctx-.*', 'general'],
      instanceId: 'proc-abc123',
    };
    expect(decodePresence(encodePresence(rec))).toEqual(rec);
  });

  it('defaults postTopics/instanceId for an old beat that omits them (additive fields, no version bump)', () => {
    const rec = decodePresence(JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'] }));
    expect(rec).toEqual({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], postTopics: [], instanceId: '' });
  });

  it('drops a malformed / empty instanceId to the anonymous sentinel (untrusted input)', () => {
    const notString = JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], instanceId: 42 });
    expect(decodePresence(notString)?.instanceId).toBe('');
    const empty = JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], instanceId: '' });
    expect(decodePresence(empty)?.instanceId).toBe('');
  });

  it('truncates an over-long instanceId', () => {
    const instanceId = 'x'.repeat(MAX_INSTANCE_ID_LEN + 50);
    const rec = decodePresence(JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], instanceId }));
    expect(rec?.instanceId).toHaveLength(MAX_INSTANCE_ID_LEN);
  });

  it('drops a malformed postTopics to [] rather than rejecting the whole beat (untrusted input)', () => {
    const bad = JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], postTopics: [42, ''] });
    expect(decodePresence(bad)?.postTopics).toEqual([]);
    const notArray = JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], postTopics: 'ctx-.*' });
    expect(decodePresence(notArray)?.postTopics).toEqual([]);
  });

  it('truncates an over-long postTopics list', () => {
    const postTopics = Array.from({ length: MAX_RECORD_TOPICS + 10 }, (_, i) => `p-${i}`);
    const rec = decodePresence(
      JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], postTopics }),
    );
    expect(rec?.postTopics).toHaveLength(MAX_RECORD_TOPICS);
    expect(rec?.postTopics[0]).toBe('p-0');
  });

  it('rejects malformed / non-presence content (untrusted input)', () => {
    expect(decodePresence('not json')).toBeNull();
    expect(decodePresence('42')).toBeNull();
    expect(decodePresence('null')).toBeNull();
    // A pre-v2 (old per-topic) record no longer decodes.
    expect(decodePresence(JSON.stringify({ v: 1, kind: 'hello', at: 1 }))).toBeNull();
    expect(decodePresence(JSON.stringify({ v: 2, kind: 'wave', at: 1, topics: ['ctx'] }))).toBeNull();
    expect(decodePresence(JSON.stringify({ v: 2, kind: 'hello', topics: ['ctx'] }))).toBeNull();
    expect(decodePresence(JSON.stringify({ v: 2, kind: 'hello', at: 'soon', topics: ['ctx'] }))).toBeNull();
  });

  it('rejects a record with a missing / malformed topics list', () => {
    expect(decodePresence(JSON.stringify({ v: 2, kind: 'hello', at: 1 }))).toBeNull();
    expect(decodePresence(JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: 'ctx' }))).toBeNull();
    expect(decodePresence(JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: [42] }))).toBeNull();
    expect(decodePresence(JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: [''] }))).toBeNull();
  });

  it('truncates an over-long topics list rather than rejecting it', () => {
    const topics = Array.from({ length: MAX_RECORD_TOPICS + 10 }, (_, i) => `ctx-${i}`);
    const rec = decodePresence(JSON.stringify({ v: 2, kind: 'hello', at: 1, topics }));
    expect(rec?.topics).toHaveLength(MAX_RECORD_TOPICS);
    expect(rec?.topics[0]).toBe('ctx-0');
  });
});

describe('computeRoster', () => {
  const now = 100_000;
  const ttl = 90_000;
  const since = 600_000; // offline window, well beyond ttl for these fixtures
  const opts = { ttlMs: ttl, sinceMs: since };

  it('lists an online handle whose latest beat is a fresh hello/heartbeat, with its topics + postTopics', () => {
    const roster = computeRoster(
      [beat('claude-a', 'hello', now - 1000, 1, ['ctx-x', 'ctx-y'], ['ctx-.*'])],
      now,
      opts,
    );
    expect(roster).toEqual([
      {
        handle: 'claude-a',
        online: true,
        topics: ['ctx-x', 'ctx-y'],
        postTopics: ['ctx-.*'],
        lastSeenMs: now - 1000,
      },
    ]);
  });

  it('takes the latest beat per instance (later cursor wins) and refreshes freshness + topics', () => {
    const msgs = [
      beat('claude-a', 'hello', now - 80_000, 1, ['ctx-a']),
      beat('claude-a', 'heartbeat', now - 1_000, 2, ['ctx-a', 'ctx-b'], ['ctx-.*']),
    ];
    expect(computeRoster(msgs, now, opts)).toEqual([
      {
        handle: 'claude-a',
        online: true,
        topics: ['ctx-a', 'ctx-b'],
        postTopics: ['ctx-.*'],
        lastSeenMs: now - 1_000,
      },
    ]);
  });

  it('marks a handle offline when its latest beat is goodbye, but still surfaces it within the since window', () => {
    const msgs = [
      beat('claude-a', 'heartbeat', now - 1_000, 1),
      beat('claude-a', 'goodbye', now - 500, 2),
    ];
    expect(computeRoster(msgs, now, opts)).toEqual([
      { handle: 'claude-a', online: false, topics: ['ctx'], postTopics: [], lastSeenMs: now - 500 },
    ]);
  });

  it('drops an offline handle whose last beat is older than the since window', () => {
    const msgs = [beat('claude-a', 'goodbye', now - since, 1)]; // exactly since ⇒ dropped
    expect(computeRoster(msgs, now, opts)).toEqual([]);
    const stale = [beat('claude-a', 'goodbye', now - since - 1, 1)];
    expect(computeRoster(stale, now, opts)).toEqual([]);
  });

  it('keeps a handle ONLINE when a different instance said goodbye after its hello (stale-goodbye scope, #14)', () => {
    // Relaunch overlap: the new process posts hello (cursor 1); the old process then posts its
    // trailing goodbye (cursor 2, later). Per-instance scoping must NOT let the old instance's
    // goodbye reap the new instance — the handle stays online. `lastSeenMs` is the freshest beat of
    // any kind (the trailing goodbye), which the new instance's next heartbeat supersedes.
    const msgs = [
      beat('claude-a', 'hello', now - 1_000, 1, ['ctx'], [], 'inst-new'),
      beat('claude-a', 'goodbye', now - 500, 2, ['ctx'], [], 'inst-old'),
    ];
    expect(computeRoster(msgs, now, opts)).toEqual([
      { handle: 'claude-a', online: true, topics: ['ctx'], postTopics: [], lastSeenMs: now - 500 },
    ]);
  });

  it('unions topics/postTopics across an online handle live instances', () => {
    const msgs = [
      beat('claude-a', 'hello', now - 2_000, 1, ['ctx-a'], ['a-.*'], 'inst-1'),
      beat('claude-a', 'heartbeat', now - 800, 2, ['ctx-b'], ['b-.*'], 'inst-2'),
    ];
    const roster = computeRoster(msgs, now, opts);
    expect(roster).toHaveLength(1);
    const entry = roster[0]!;
    expect(entry.online).toBe(true);
    expect([...entry.topics].sort()).toEqual(['ctx-a', 'ctx-b']);
    expect([...entry.postTopics].sort()).toEqual(['a-.*', 'b-.*']);
    expect(entry.lastSeenMs).toBe(now - 800);
  });

  it('an offline handle uses its single last-known beat for topics/reach', () => {
    const msgs = [
      beat('claude-a', 'heartbeat', now - 2_000, 1, ['ctx-old'], ['old-.*']),
      beat('claude-a', 'goodbye', now - 500, 2, ['ctx-new'], ['new-.*']),
    ];
    expect(computeRoster(msgs, now, opts)).toEqual([
      {
        handle: 'claude-a',
        online: false,
        topics: ['ctx-new'],
        postTopics: ['new-.*'],
        lastSeenMs: now - 500,
      },
    ]);
  });

  it('reclaims a handle by TTL (no goodbye) — offline once its last beat ages past ttl, still listed within since', () => {
    const msgs = [beat('claude-a', 'heartbeat', now - ttl, 1)]; // exactly ttl ⇒ not online
    expect(computeRoster(msgs, now, opts)).toEqual([
      { handle: 'claude-a', online: false, topics: ['ctx'], postTopics: [], lastSeenMs: now - ttl },
    ]);
  });

  it('ignores stray non-presence messages on the topic', () => {
    const stray: Message = { ...beat('x', 'hello', now, 1), content: 'plain chatter' };
    expect(computeRoster([stray], now, opts)).toEqual([]);
  });

  it('sorts most-recently-seen first (online floats above older offline)', () => {
    const msgs = [
      beat('human-x', 'heartbeat', now - 1_000, 1), // online, freshest
      beat('claude-b', 'goodbye', now - 5_000, 2), // offline, oldest
      beat('claude-a', 'heartbeat', now - 3_000, 3), // online, middle
    ];
    expect(computeRoster(msgs, now, opts).map((e) => [e.handle, e.online])).toEqual([
      ['human-x', true],
      ['claude-a', true],
      ['claude-b', false],
    ]);
  });

  it('breaks lastSeenMs ties by handle ascending', () => {
    const msgs = [
      beat('claude-b', 'heartbeat', now - 1_000, 1),
      beat('claude-a', 'heartbeat', now - 1_000, 2),
    ];
    expect(computeRoster(msgs, now, opts).map((e) => e.handle)).toEqual(['claude-a', 'claude-b']);
  });
});

// CX-05 payoff: the hand-off reachability predicate is now a PURE, directly-callable function that
// lives beside computeRoster — no MCP client/server harness required (the whole point of the extract).
describe('filterReachable (pure reachability predicate — CX-05)', () => {
  /** A roster entry; only `topics`/`postTopics` drive the predicate (online/lastSeenMs are inert here). */
  const entry = (handle: string, topics: string[], postTopics: string[] = []): RosterEntry => ({
    handle: asHandle(handle),
    online: true,
    topics,
    postTopics,
    lastSeenMs: 0,
  });
  const NEVER = () => false;

  it('(a) scoped — includes a peer that only PATTERN-matches the scope via postTopics; excludes one that neither subscribes nor matches', () => {
    const roster = [
      entry('subber', ['ctx-adhoc']), // subscribes to the scope directly
      entry('poster', ['elsewhere'], ['ctx-.*']), // only its post-pattern covers the scope
      entry('stranger', ['other'], ['unrelated-.*']), // neither subscribes nor matches
    ];
    const got = filterReachable(roster, { scope: 'ctx-adhoc', canPostTo: NEVER, mySubscribedTopics: [] });
    expect(got.map((e) => e.handle)).toEqual(['subber', 'poster']);
  });

  it('(b) unscoped bidirectional — includes a peer I can post to AND a peer that can post to a topic I subscribe to; excludes an unrelated peer', () => {
    const roster = [
      entry('i-can-post-to', ['their-topic']), // I can post to a topic it subscribes to
      entry('can-post-to-me', ['elsewhere'], ['mine-.*']), // its post-pattern covers a topic I subscribe to
      entry('unrelated', ['nowhere'], ['no-.*']), // no channel in either direction
    ];
    const got = filterReachable(roster, {
      scope: undefined,
      canPostTo: (t) => t === 'their-topic', // stands in for `allow.has`
      mySubscribedTopics: ['mine-1'], // stands in for `allow.topics()`
    });
    expect(got.map((e) => e.handle).sort()).toEqual(['can-post-to-me', 'i-can-post-to']);
  });

  it('(c) silently ignores a hostile un-compilable / over-long postTopics source (never throws), scoped or unscoped', () => {
    const roster = [entry('hostile', ['other'], ['(', 'x'.repeat(10_000)])];
    const scoped = () => filterReachable(roster, { scope: 'ctx', canPostTo: NEVER, mySubscribedTopics: [] });
    const unscoped = () =>
      filterReachable(roster, { scope: undefined, canPostTo: NEVER, mySubscribedTopics: ['ctx'] });
    expect(scoped).not.toThrow();
    expect(unscoped).not.toThrow();
    expect(scoped()).toEqual([]); // broken/huge patterns compile to nothing ⇒ no false match
    expect(unscoped()).toEqual([]);
  });

  it('(d) SEC-08 — a beat of 64 nested-quantifier postTopics returns in bounded time (no ReDoS hang)', () => {
    // A hostile peer plants the maximum 64 catastrophic-backtracking sources; the reader's real,
    // short topic name is the match input. On the unfixed code a single `.test` against a 15-char
    // topic hangs the whole process for >8s — here the ReDoS screen rejects the sources up front, so
    // the pathological peer is simply excluded (no shared channel) and the call returns immediately.
    const evil = '((([a-z-]+)+)+)+[0-9]'; // 20 source chars, catastrophic on Node's engine
    const roster = [entry('attacker', ['some-other-ctx'], Array<string>(64).fill(evil))];
    const scopedT0 = performance.now();
    const scoped = filterReachable(roster, {
      scope: 'team-eng-alerts', // a short, ordinary 15-char topic the unfixed matcher hangs on
      canPostTo: NEVER,
      mySubscribedTopics: [],
    });
    expect(performance.now() - scopedT0).toBeLessThan(200);
    expect(scoped).toEqual([]);

    const unscopedT0 = performance.now();
    const unscoped = filterReachable(roster, {
      scope: undefined,
      canPostTo: NEVER,
      mySubscribedTopics: ['team-eng-alerts'],
    });
    expect(performance.now() - unscopedT0).toBeLessThan(200);
    expect(unscoped).toEqual([]);
  });

  it('(d2) SEC-08 — a BOUNDED exact-count nested quantifier is also screened (no ReDoS hang)', () => {
    // The bounded-quantifier bypass class: `([a-z-]*){40}[0-9]` has only `*` and a bounded exact
    // `{40}` (no unbounded outer quantifier), so the earlier screen — which rejected only UNBOUNDED
    // outer quantifiers — let it through, yet V8 unrolls `{40}` into 40 sequential `*`-bodies and the
    // match hangs Node for tens of seconds on a short 15-char topic. The screen must reject a risky
    // body repeated `>= 2` times regardless of boundedness, so the peer is excluded and the call
    // returns immediately.
    const evil = '([a-z-]*){40}[0-9]';
    const roster = [entry('attacker', ['some-other-ctx'], Array<string>(64).fill(evil))];
    const scopedT0 = performance.now();
    const scoped = filterReachable(roster, {
      scope: 'team-eng-alerts', // a short, ordinary 15-char topic the unfixed matcher hangs on
      canPostTo: NEVER,
      mySubscribedTopics: [],
    });
    expect(performance.now() - scopedT0).toBeLessThan(200);
    expect(scoped).toEqual([]);

    const unscopedT0 = performance.now();
    const unscoped = filterReachable(roster, {
      scope: undefined,
      canPostTo: NEVER,
      mySubscribedTopics: ['team-eng-alerts'],
    });
    expect(performance.now() - unscopedT0).toBeLessThan(200);
    expect(unscoped).toEqual([]);
  });

  it('(e) SEC-08 — a benign postTopics pattern still legitimately matches (screen preserves semantics)', () => {
    const roster = [entry('peer', ['elsewhere'], ['team-.*'])];
    // scoped: the peer's `team-.*` covers the scope.
    expect(
      filterReachable(roster, { scope: 'team-eng-alerts', canPostTo: NEVER, mySubscribedTopics: [] }).map(
        (e) => e.handle,
      ),
    ).toEqual(['peer']);
    // unscoped: the peer can post to a topic I subscribe to.
    expect(
      filterReachable(roster, {
        scope: undefined,
        canPostTo: NEVER,
        mySubscribedTopics: ['team-eng-alerts'],
      }).map((e) => e.handle),
    ).toEqual(['peer']);
  });
});
