import { describe, expect, it } from 'vitest';
import { asBackendMsgId, asCursor, asHandle, asTopic, type Message } from '../message.js';
import { isRedosSafeSource, MAX_MATCH_INPUT } from '../regex-safety.js';
import { SAFE_PATTERNS } from '../testing/regex-corpus.js';
import {
  computeRoster,
  decodePresence,
  encodePresence,
  filterReachable,
  MAX_CLOCK_SKEW_MS,
  MAX_HANDLE_INSTANCES,
  MAX_HANDLE_LEN,
  MAX_INSTANCE_ID_LEN,
  MAX_RECORD_TOPICS,
  MAX_ROSTER_ENTRIES,
  MAX_TOPIC_LEN,
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

  it('drops a malformed postTopics to [] rather than rejecting the whole beat (untrusted input)', () => {
    const bad = JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], postTopics: [42, ''] });
    expect(decodePresence(bad)?.postTopics).toEqual([]);
    const notArray = JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], postTopics: 'ctx-.*' });
    expect(decodePresence(notArray)?.postTopics).toEqual([]);
  });

  /**
   * Every length cap at decode is one axis — (field, how far over, expectation) — so table it rather
   * than writing a case per field: a cap added to a new PresenceRecord field joins a row instead of
   * needing a new body. The ONE policy in every cell is that an over-cap string never becomes a
   * different valid value; where it lands differs only because `handle`/`instanceId` become roster
   * MAP KEYS, so a truncated one would silently merge two peers (or two instances) into one slot and
   * has to take its whole record with it.
   */
  describe('an over-cap string is never truncated into a different valid value', () => {
    const OVER = [
      ['one character over', 1],
      ['far over', 5_000],
    ] as const;

    it.each(
      ([['instanceId', MAX_INSTANCE_ID_LEN], ['handle', MAX_HANDLE_LEN]] as const).flatMap(([field, cap]) =>
        OVER.map(([label, by]) => [field, cap, label, by] as const),
      ),
    )('%s at its cap %i is kept, %s rejects the whole record', (field, cap, _label, by) => {
      const at = JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], [field]: 'y'.repeat(cap) });
      expect(decodePresence(at)?.[field]).toHaveLength(cap);
      const over = JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], [field]: 'x'.repeat(cap + by) });
      expect(decodePresence(over)).toBeNull();
    });

    it.each(
      (['topics', 'postTopics'] as const).flatMap((field) =>
        OVER.map(([label, by]) => [field, label, by] as const),
      ),
    )('%s keeps a member at MAX_TOPIC_LEN and drops one %s', (field, _label, by) => {
      const atTheCap = 'y'.repeat(MAX_TOPIC_LEN);
      const over = 'x'.repeat(MAX_TOPIC_LEN + by);
      const rec = decodePresence(
        JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], [field]: [over, 'keep-me', atTheCap] }),
      );
      expect(rec?.[field]).toEqual(['keep-me', atTheCap]);
    });
  });

  it.each(['topics', 'postTopics'] as const)('%s caps its COUNT at MAX_RECORD_TOPICS', (field) => {
    const many = Array.from({ length: MAX_RECORD_TOPICS + 10 }, (_unused, i) => `e-${i}`);
    const rec = decodePresence(
      JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], [field]: many }),
    );
    expect(rec?.[field]).toHaveLength(MAX_RECORD_TOPICS);
    expect(rec?.[field][0]).toBe('e-0');
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

  /**
   * A handle's advertised reach is folded across its instances — the union of the LIVE ones when any
   * is online, and the single FRESHEST beat when none is — and the fold direction is unobservable
   * with one instance, which is all any case here used to feed. Cross the instance count with how
   * the handle went offline (goodbye, TTL, a mix) and with whether one is still live, and assert the
   * reported topics/postTopics by value: folding to the oldest instance, or letting departed
   * instances back into an online entry, flips a row while `lastSeenMs` still reads fresh.
   */
  describe('folding a handle across instances reports the freshest, never the oldest', () => {
    /** One instance of the handle: its id (repeat one to re-beat the same instance), kind, age, topic. */
    type Inst = [id: string, kind: PresenceKind, ageMs: number, topic: string];

    const page = (insts: Inst[]): Message[] =>
      insts.map(([id, kind, ageMs, topic], i) =>
        beat('claude-a', kind, now - ageMs, i + 1, [topic], [`${topic}-.*`], id),
      );

    const ROWS: Array<
      [name: string, insts: Inst[], online: boolean, topics: string[], lastSeenAgeMs: number]
    > = [
      [
        'one anonymous instance, its latest beat superseding its earlier one',
        [['', 'heartbeat', 2_000, 'ctx-old'], ['', 'goodbye', 500, 'ctx-new']],
        false,
        ['ctx-new'],
        500,
      ],
      ['one instance, gone by goodbye', [['i0', 'goodbye', 500, 'ctx-0']], false, ['ctx-0'], 500],
      [
        'one instance, aged past the ttl',
        [['i0', 'heartbeat', ttl + 500, 'ctx-0']],
        false,
        ['ctx-0'],
        ttl + 500,
      ],
      [
        'two instances, both gone by goodbye',
        [
          ['inst-old', 'goodbye', 50_000, 'ctx-old'],
          ['inst-new', 'goodbye', 1_000, 'ctx-new'],
        ],
        false,
        ['ctx-new'],
        1_000,
      ],
      [
        'two instances, both aged past the ttl',
        [
          ['inst-old', 'heartbeat', ttl + 50_000, 'ctx-old'],
          ['inst-new', 'heartbeat', ttl + 1_000, 'ctx-new'],
        ],
        false,
        ['ctx-new'],
        ttl + 1_000,
      ],
      [
        'four instances offline by a mix of goodbye and ttl',
        [
          ['a', 'heartbeat', ttl + 5_000, 'ctx-a'],
          ['b', 'goodbye', 60_000, 'ctx-b'],
          ['c', 'heartbeat', ttl + 2_000, 'ctx-c'],
          ['d', 'goodbye', 500, 'ctx-d'],
        ],
        false,
        ['ctx-d'],
        500,
      ],
      [
        'four instances, one live behind a fresher goodbye',
        [
          ['live', 'heartbeat', 1_000, 'ctx-live'],
          ['gone', 'goodbye', 500, 'ctx-gone'],
          ['stale', 'heartbeat', ttl + 9_000, 'ctx-stale'],
          ['older', 'goodbye', 70_000, 'ctx-older'],
        ],
        true,
        ['ctx-live'],
        500,
      ],
      [
        'four instances, two live',
        [
          ['live-1', 'heartbeat', 1_000, 'ctx-live-1'],
          ['live-2', 'heartbeat', 2_000, 'ctx-live-2'],
          ['gone', 'goodbye', 300, 'ctx-gone'],
          ['stale', 'heartbeat', ttl + 1, 'ctx-stale'],
        ],
        true,
        ['ctx-live-1', 'ctx-live-2'],
        300,
      ],
    ];

    it.each(ROWS)('%s', (_name, insts, online, topics, lastSeenAgeMs) => {
      const roster = computeRoster(page(insts), now, opts);
      expect(roster).toHaveLength(1);
      const entry = roster[0]!;
      expect(entry.online).toBe(online);
      expect([...entry.topics].sort()).toEqual([...topics].sort());
      expect([...entry.postTopics].sort()).toEqual(topics.map((t) => `${t}-.*`).sort());
      expect(entry.lastSeenMs).toBe(now - lastSeenAgeMs);
    });
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

  /**
   * The self-reported `at` is untrusted, and every case about it is one parameter: `at - now`. Table
   * the offset instead of writing a body per point, with the boundary rows DERIVED from
   * MAX_CLOCK_SKEW_MS so moving the constant moves the boundary instead of leaving stale prose names
   * behind. A far-future value must never enter the roster: it would read as permanently `online` and
   * pin a phantom hand-off target at the top of the list forever, immune to both windows.
   */
  describe('the untrusted `at` is trusted only inside the skew tolerance', () => {
    const FUTURE_AT = 8_640_000_000_000_000; // max representable Date ms

    /** `top` is who leads the recency sort — the slot a phantom peer would otherwise pin forever. */
    const OFFSETS: Array<
      [label: string, offset: number, decoded: boolean, online: boolean, listed: boolean, top: string]
    > = [
      ['aged past the ttl but inside the since window', -ttl - 1, true, false, true, 'real'],
      ['older than the since window', -since - 1, true, false, false, 'real'],
      ['a fresh past beat', -1_000, true, true, true, 'real'],
      ['a legitimate small clock skew', 1_000, true, true, true, 'zzz-spoof'],
      ['exactly at the skew tolerance', MAX_CLOCK_SKEW_MS, true, true, true, 'zzz-spoof'],
      ['one ms beyond the skew tolerance', MAX_CLOCK_SKEW_MS + 1, false, false, false, 'real'],
      ['a far-future spoof', 1e12, false, false, false, 'real'],
      ['the maximum representable date', FUTURE_AT - now, false, false, false, 'real'],
    ];

    it.each(OFFSETS)(
      '%s (offset %i ms) ⇒ decoded=%s, online=%s, listed=%s, roster led by %s',
      (_label, offset, decoded, online, listed, top) => {
        const at = now + offset;
        const rec = decodePresence(JSON.stringify({ v: 2, kind: 'heartbeat', at, topics: ['ctx'] }), now);
        expect(rec !== null).toBe(decoded);
        if (decoded) expect(rec?.at).toBe(at);

        // A legitimate peer beats alongside it, so a surviving spoof has to displace it to lead.
        const roster = computeRoster(
          [beat('zzz-spoof', 'heartbeat', at, 1, ['dev']), beat('real', 'heartbeat', now - 1, 2)],
          now,
          opts,
        );
        const entry = roster.find((e) => e.handle === 'zzz-spoof');
        expect(entry !== undefined).toBe(listed);
        expect(entry?.online ?? false).toBe(online);
        expect(roster[0]?.handle).toBe(top);
      },
    );

    it('a pure decode with no nowMs leaves `at` unbounded (round-trip callers)', () => {
      expect(decodePresence(JSON.stringify({ v: 2, kind: 'hello', at: now + 1e12, topics: ['ctx'] }))).not.toBeNull();
    });

    it('a rejected spoof cannot outlive a legit peer that ages out (immune-forever regression)', () => {
      // The SAME page evaluated at a much later now: the legit peer correctly ages out of both
      // windows, and the phantom must not be left behind as the sole surviving hand-off target.
      const msgs = [beat('zzz-spoof', 'heartbeat', FUTURE_AT, 1, ['dev']), beat('real', 'heartbeat', now, 2)];
      expect(computeRoster(msgs, now, opts).map((e) => e.handle)).toEqual(['real']);
      expect(computeRoster(msgs, now + 100 * ttl, opts)).toEqual([]);
    });
  });
});

/**
 * MAX_RECORD_TOPICS / MAX_TOPIC_LEN bound ONE beat. computeRoster then unions across every instance
 * of a handle, and the instance count is chosen by whoever writes the beats (a fresh `instanceId` per
 * beat costs nothing), so a per-record cap alone multiplies by the presence page size — 500 beats of
 * 64 max-length topics reached a 33 MB roster that `parley_list_users` returns verbatim into the
 * agent's context and that filterReachable then compiles 32,000 untrusted regexes out of.
 *
 * Table the axes that MULTIPLY and assert the budget on the OUTPUT, so a new PresenceRecord field
 * inherits it: exact entry counts (a ceiling alone is satisfied by returning nothing), a fixed byte
 * ceiling per entry, and a wall-clock bound on the regex compile that consumes it.
 */
describe('the per-record budget survives aggregation across instances', () => {
  const now = 1_000_000;
  const ttl = 90_000;
  const opts = { ttlMs: ttl, sinceMs: 600_000 };
  /** 64 topics + 64 postTopics of 512 chars, plus JSON quoting and the entry's scalar fields. */
  const ENTRY_BUDGET_BYTES = 100_000;
  const COMPILE_BOUND_MS = 200;

  const padded = (prefix: string, len: number): string =>
    prefix.length >= len ? prefix.slice(0, len) : prefix + 'x'.repeat(len - prefix.length);

  function hostilePage(instances: number, perRecord: number, strLen: number): Message[] {
    return Array.from({ length: instances }, (_unused, i) =>
      beat(
        'attacker',
        'heartbeat',
        now - 1_000,
        i + 1,
        Array.from({ length: perRecord }, (_u, j) => padded(`t-${i}-${j}-`, strLen)),
        Array.from({ length: perRecord }, (_u, j) => padded(`p-${i}-${j}-`, strLen)),
        `inst-${i}`,
      ),
    );
  }

  it.each([
    [1, 64, MAX_TOPIC_LEN],
    [8, 64, MAX_TOPIC_LEN],
    [500, 64, MAX_TOPIC_LEN],
    [500, 1, MAX_TOPIC_LEN],
    [500, 64, 8],
  ])('%i instances × %i entries × %i-char strings', (instances, perRecord, strLen) => {
    const roster = computeRoster(hostilePage(instances, perRecord, strLen), now, opts);
    expect(roster).toHaveLength(1); // one writer is one peer, however many instances it mints

    const entry = roster[0]!;
    const folded = Math.min(instances, MAX_HANDLE_INSTANCES) * perRecord;
    const expected = Math.min(folded, MAX_RECORD_TOPICS);
    // Exact, not just "<= cap": the caps must bound the union without emptying the peer's reach.
    expect(entry.topics).toHaveLength(expected);
    expect(entry.postTopics).toHaveLength(expected);
    expect(JSON.stringify(entry).length).toBeLessThan(ENTRY_BUDGET_BYTES);

    const t0 = performance.now();
    filterReachable(roster, { scope: undefined, canPostTo: () => false, mySubscribedTopics: ['ctx'] });
    expect(performance.now() - t0).toBeLessThan(COMPILE_BOUND_MS);
  });

  it('still unions the reach of a handle live instances (the cap is a ceiling, not a replacement)', () => {
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

  /**
   * Which instances survive the cap is a function of the BEATS, not of the order they arrived in —
   * `instance_id` defaults to the handle and agent sessions are ephemeral, so a handle whose sessions
   * churn faster than its heartbeat routinely posts a long-lived instance FIRST and a run of
   * short-lived ones after it. Cross the survivor's arrival position with the sibling kind, the
   * sibling count and whether the survivor is the freshest or the stalest of them, and compute the
   * expectation from the policy: a live instance outranks any `goodbye`, and among same-kind beats
   * the freshest `at` wins. The evicted cell is asserted too — a retention rule that keeps everything
   * would satisfy a survival-only table.
   */
  describe('the instance cap keeps the freshest live instances, whatever order they arrived in', () => {
    const N = MAX_HANDLE_INSTANCES;
    const POSITIONS = ['before', 'interleaved', 'after'] as const;
    const KINDS = ['heartbeat', 'goodbye'] as const;
    const COUNTS = [N, N * 2, N * 4];
    const AGES = ['freshest', 'stalest'] as const;

    const CELLS = POSITIONS.flatMap((position) =>
      KINDS.flatMap((kind) =>
        COUNTS.flatMap((count) => AGES.map((age) => [position, kind, count, age] as const)),
      ),
    );

    it.each(CELLS)(
      'survivor beating %s a flood of %i %s siblings, and the %s of them',
      (position, kind, count, age) => {
        const survivorAt = age === 'freshest' ? now - 500 : now - 60_000;
        const siblingAt = (i: number) => (age === 'freshest' ? now - 50_000 + i : now - 1_000 - i);
        const siblings = Array.from({ length: count }, (_unused, i) =>
          beat('claude-a', kind, siblingAt(i), 100 + i, [`ctx-sib-${i}`], [], `sib-${i}`),
        );
        const survivor = beat('claude-a', 'heartbeat', survivorAt, 1, ['ctx-survivor'], [], 'inst-survivor');
        const at = position === 'before' ? 0 : position === 'after' ? siblings.length : count >> 1;
        const page = [...siblings.slice(0, at), survivor, ...siblings.slice(at)];

        // The survivor loses its slot only when every sibling outranks it: same kind, and fresher.
        const retained = kind === 'goodbye' || age === 'freshest';
        const entry = computeRoster(page, now, opts)[0]!;

        // Exact, not "at most": an online entry advertises every LIVE instance it retained, so a
        // rule that kept nothing, or that folded the departed siblings back in, fails here too.
        expect(entry.online).toBe(true);
        expect(entry.topics).toHaveLength(kind === 'goodbye' ? 1 : N);
        expect(entry.topics.includes('ctx-survivor')).toBe(retained);
      },
    );
  });

  /**
   * `limit` is a maximum the seam only ASKS for — nonconformant.ts models a page longer than it as a
   * shape core's loops must survive — so the number of records folded here is plugin-chosen, not
   * bounded by the request. At this size an unbounded fold is not merely large: it is a RangeError
   * from a spread whose argument count is the record count, so `parley_list_users` answers with an
   * internal error instead of a roster.
   */
  it('folds a page far longer than any requested limit into a bounded entry', () => {
    // Past the argument-count ceiling a spread of one record per beat hits (~125k on Node 22), so an
    // unbounded fold fails loudly here rather than merely returning something large.
    const page = Array.from({ length: 130_000 }, (_unused, i) =>
      beat('attacker', 'heartbeat', now - 1_000, i + 1, [`ctx-${i}`], [], `inst-${i}`),
    );
    const roster = computeRoster(page, now, opts);
    expect(roster).toHaveLength(1);
    expect(roster[0]!.topics).toHaveLength(MAX_HANDLE_INSTANCES);
    expect(roster[0]!.lastSeenMs).toBe(now - 1_000);
  });
});

/**
 * Every cap above bounds ONE record or ONE handle, and each is multiplied by a factor none of them
 * touches: how many ENTRIES the roster carries. A beat's `handle` is self-reported, so one
 * credential mints as many peers as it has beats, and each of those peers advertises its own legal
 * 64 patterns that `filterReachable` compiles and tests against every topic the caller subscribes
 * to. `regex-safety.ts` states the ambiguity bound is per SOURCE and that the caller must also bound
 * HOW MANY it holds; this is the case that pays for it. Sweep the multiplying dimensions one at a
 * time — a cap restored on only one of them must not pass — take the costliest source the screen
 * ACCEPTS from the shared corpus by MEASUREMENT rather than by name (a hard-coded one lets the
 * corpus widen past the test), and grade the two things the caller actually pays: synchronous CPU
 * and the bytes that land in the agent's context.
 */
describe('untrusted presence history cannot exceed a CPU or byte budget', () => {
  const now = 1_000_000;
  const opts = { ttlMs: 90_000, sinceMs: 600_000 };
  /** PRESENCE_FETCH_LIMIT: the most beats one roster is ever built from. */
  const PAGE = 500;
  const CALLER_TOPICS = 20;
  const CPU_BUDGET_MS = 500;
  /** What one maximal entry can legally serialize to: topics AND postTopics, each capped both ways. */
  const ENTRY_BYTES = 2 * MAX_RECORD_TOPICS * (MAX_TOPIC_LEN + 8) + 256;
  const ROSTER_BUDGET_BYTES = MAX_ROSTER_ENTRIES * ENTRY_BYTES;

  const worstAcceptedSource = (): string => {
    const input = 'a'.repeat(MAX_MATCH_INPUT);
    let worst = '';
    let worstMs = -1;
    for (const [, src] of SAFE_PATTERNS) {
      if (!isRedosSafeSource(src)) continue;
      const re = new RegExp(`^(?:${src})$`);
      const t0 = performance.now();
      for (let rep = 0; rep < 3; rep++) re.test(input);
      const ms = performance.now() - t0;
      if (ms > worstMs) {
        worstMs = ms;
        worst = src;
      }
    }
    return worst;
  };
  const WORST = worstAcceptedSource();

  /** Pad to the per-string cap so each cell is worst case in bytes as well as in backtracking. */
  const padded = (head: string): string =>
    head.length >= MAX_TOPIC_LEN ? head.slice(0, MAX_TOPIC_LEN) : head + 'y'.repeat(MAX_TOPIC_LEN - head.length);

  function hostilePage(handles: number, instances: number, patterns: number): Message[] {
    const page: Message[] = [];
    let seq = 0;
    for (let h = 0; h < handles; h++) {
      for (let i = 0; i < instances; i++) {
        seq++;
        page.push({
          topic: asTopic('parley-presence'),
          // ONE writer holding ONE credential: every `handle` below is self-reported by the record.
          senderHandle: asHandle('one-credential'),
          content: encodePresence({
            v: 2,
            kind: 'heartbeat',
            at: now - 1_000,
            handle: `peer-${h}`,
            topics: [padded(`t-${h}-${i}-`)],
            postTopics: Array.from({ length: patterns }, (_u, j) => padded(`${WORST}${h}-${i}-${j}-`)),
            instanceId: `inst-${i}`,
          }),
          timestamp: new Date(seq * 1000).toISOString(),
          backendMsgId: asBackendMsgId(String(seq)),
          cursor: asCursor(String(seq)),
          mentions: [],
        });
      }
    }
    return page;
  }

  it('the corpus yields a source the screen accepts, at full length', () => {
    expect(isRedosSafeSource(WORST)).toBe(true);
    expect(isRedosSafeSource(padded(`${WORST}0-0-0-`))).toBe(true);
  });

  it.each([
    ['nothing multiplied (control)', 1, 1, 1, 1],
    ['handles alone', PAGE, 1, 1, 1],
    ['instances alone', 1, PAGE, 1, 1],
    ['patterns per beat alone', 1, 1, MAX_RECORD_TOPICS, 1],
    ['caller topics alone', 1, 1, MAX_RECORD_TOPICS, CALLER_TOPICS],
    ['handles × patterns', PAGE, 1, MAX_RECORD_TOPICS, 1],
    ['handles × patterns × caller topics', PAGE, 1, MAX_RECORD_TOPICS, CALLER_TOPICS],
    [
      'the same page split across instances',
      PAGE / MAX_HANDLE_INSTANCES,
      MAX_HANDLE_INSTANCES,
      MAX_RECORD_TOPICS,
      CALLER_TOPICS,
    ],
  ])('%s', (_name, handles, instances, patterns, callerTopics) => {
    const roster = computeRoster(hostilePage(handles, instances, patterns), now, opts);
    expect(roster.length).toBeGreaterThan(0); // bounded, never emptied
    expect(roster.length).toBeLessThanOrEqual(MAX_ROSTER_ENTRIES);
    expect(JSON.stringify(roster).length).toBeLessThan(ROSTER_BUDGET_BYTES);

    const mine = Array.from({ length: callerTopics }, (_u, i) => `mine-${i}`.padEnd(MAX_MATCH_INPUT, 'a'));
    const unscopedT0 = performance.now();
    filterReachable(roster, { scope: undefined, canPostTo: () => false, mySubscribedTopics: mine });
    expect(performance.now() - unscopedT0).toBeLessThan(CPU_BUDGET_MS);

    const scopedT0 = performance.now();
    filterReachable(roster, { scope: mine[0]!, canPostTo: () => false, mySubscribedTopics: [] });
    expect(performance.now() - scopedT0).toBeLessThan(CPU_BUDGET_MS);
  });
});

/**
 * The seam does NOT require a backend to carry the posting identity — the conformance suite makes
 * it explicitly optional, and a bot-token backend delivers every session's beats under one bot
 * handle. A roster keyed on `Message.senderHandle` therefore collapses a whole fleet into a single
 * phantom peer on those backends. Table both kinds of attribution and require the same answer from
 * each: N emitting bridges are N roster entries, each carrying its OWN topics.
 */
describe('the roster keys on the emitting bridge, not on the backend sender', () => {
  const now = 1_700_000_000_000;
  const opts = { ttlMs: 90_000, sinceMs: 600_000 };
  const BOT = 'parley-bot@localhost';

  /** A beat that names its own emitter inside the record (what every current bridge posts). */
  function selfNamed(handle: string, seq: number, sender: string): Message {
    return {
      topic: asTopic('parley-presence'),
      senderHandle: asHandle(sender),
      content: encodePresence({
        v: 2,
        kind: 'hello',
        at: now - 1_000,
        handle,
        topics: [`topic-${handle}`],
        postTopics: [],
        instanceId: `inst-${handle}`,
      }),
      timestamp: new Date(seq * 1000).toISOString(),
      backendMsgId: asBackendMsgId(String(seq)),
      cursor: asCursor(String(seq)),
      mentions: [],
    };
  }

  const attributions: Array<[name: string, sender: (handle: string) => string]> = [
    ['a backend that carries sender identity', (handle) => handle],
    ['a bot-token backend that carries only its own', () => BOT],
  ];

  it.each(attributions)('%s: three bridges are three peers', (_name, sender) => {
    const handles = ['ctx-payments', 'ctx-reviews', 'ops'];
    const msgs = handles.map((h, i) => selfNamed(h, i + 1, sender(h)));
    const roster = computeRoster(msgs, now, opts);

    expect(roster.map((e) => e.handle).sort()).toEqual([...handles].sort());
    for (const h of handles) {
      expect(roster.find((e) => e.handle === h)?.topics).toEqual([`topic-${h}`]);
    }
    expect(roster.map((e) => e.handle)).not.toContain(BOT);
  });

  /**
   * `handle` and `instanceId` are the roster's two map keys, so a length cap that TRUNCATED them
   * would merge peers that share a prefix into one entry (unioning their topics and reporting one
   * online while only the other is) and let one instance's `goodbye` reap another's slot. Pin both
   * key axes against an in-cap control, so the drop policy cannot be relaxed back to a slice.
   */
  it.each([
    ['handle', MAX_HANDLE_LEN],
    ['instanceId', MAX_INSTANCE_ID_LEN],
  ] as const)('two records differing only past the %s cap are never merged', (field, cap) => {
    const shared = 'p'.repeat(cap);
    const record = (suffix: string, topic: string) => ({
      v: 2,
      kind: 'hello',
      at: now - 1_000,
      topics: [topic],
      ...(field === 'handle'
        ? { handle: shared + suffix }
        : { handle: 'claude-a', instanceId: shared + suffix }),
    });
    const msg = (body: object, seq: number): Message => ({
      topic: asTopic('parley-presence'),
      senderHandle: asHandle('bot'),
      content: JSON.stringify(body),
      timestamp: new Date(seq * 1000).toISOString(),
      backendMsgId: asBackendMsgId(String(seq)),
      cursor: asCursor(String(seq)),
      mentions: [],
    });

    const overCap = computeRoster(
      [msg(record('-one', 'ctx-one'), 1), msg(record('-two', 'ctx-two'), 2)],
      now,
      opts,
    );
    expect(overCap).toEqual([]); // both dropped — never one entry carrying both peers' topics

    // Control: the same two records inside the cap stay two distinct keys.
    const inCap = computeRoster(
      [
        msg({ ...record('', 'ctx-one'), [field]: 'in-cap-one' }, 1),
        msg({ ...record('', 'ctx-two'), [field]: 'in-cap-two' }, 2),
      ],
      now,
      opts,
    );
    const topics = inCap.flatMap((e) => e.topics).sort();
    expect(topics).toEqual(['ctx-one', 'ctx-two']);
    expect(inCap).toHaveLength(field === 'handle' ? 2 : 1); // one handle, two instances
  });

  it('a pre-handle beat still keys on the backend sender (mixed-version compatibility)', () => {
    const roster = computeRoster([beat('claude-old', 'hello', now - 1_000, 1)], now, opts);
    expect(roster.map((e) => e.handle)).toEqual(['claude-old']);
  });

  it('old and new beats coexist as distinct peers', () => {
    const msgs = [beat('claude-old', 'hello', now - 1_000, 1), selfNamed('claude-new', 2, BOT)];
    expect(
      computeRoster(msgs, now, opts)
        .map((e) => e.handle)
        .sort(),
    ).toEqual(['claude-new', 'claude-old']);
  });

  it.each([['a number', 42], ['an empty string', ''], ['null', null]])(
    'ignores %s as a self-reported handle and falls back to the sender',
    (_name, bad) => {
      const msg: Message = {
        topic: asTopic('parley-presence'),
        senderHandle: asHandle('from-the-backend'),
        content: JSON.stringify({ v: 2, kind: 'hello', at: now - 1_000, topics: ['ctx'], handle: bad }),
        timestamp: new Date(1000).toISOString(),
        backendMsgId: asBackendMsgId('1'),
        cursor: asCursor('1'),
        mentions: [],
      };
      expect(computeRoster([msg], now, opts).map((e) => e.handle)).toEqual(['from-the-backend']);
    },
  );
});

describe('filterReachable (pure reachability predicate)', () => {
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

  it('(d) a beat of 64 nested-quantifier postTopics returns in bounded time (no ReDoS hang)', () => {
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

  it('(d2) a BOUNDED exact-count nested quantifier is also screened (no ReDoS hang)', () => {
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

  /**
   * The ReDoS screen is calibrated for an input of MAX_MATCH_INPUT characters, and regex-safety.ts
   * says so: callers MUST clamp. The two cases above fix the PATTERN axis with a short topic and
   * leave the INPUT axis constant, so the clamp itself is free to disappear. `.*.*.*.*x` passes the
   * screen (its budget is exactly the calibrated ceiling) yet costs ~9ms against 64 characters, 1.7s
   * against 256 and minutes against 1024 — so cross the axes and bound every cell in wall-clock
   * time. Topic names reach here from the operator's allowlist, which does not cap their length.
   */
  describe('a screened pattern stays cheap however long the matched topic is', () => {
    const PATTERNS = {
      'a degree-4 polynomial source that PASSES the screen': '.*.*.*.*x',
      'a source the screen rejects outright': '((([a-z-]+)+)+)+[0-9]',
      'a benign source': 'team-.*',
    };
    const LENGTHS = [8, 64, 256, 1024];
    const BOUND_MS = 500;

    for (const [label, source] of Object.entries(PATTERNS)) {
      it.each(LENGTHS)(`${label}, against a %i-character topic`, (length) => {
        const roster = [entry('attacker', ['some-other-ctx'], Array<string>(4).fill(source))];
        const topic = `team-${'a'.repeat(length - 5)}`;

        const scopedT0 = performance.now();
        filterReachable(roster, { scope: topic, canPostTo: NEVER, mySubscribedTopics: [] });
        expect(performance.now() - scopedT0).toBeLessThan(BOUND_MS);

        const unscopedT0 = performance.now();
        filterReachable(roster, { scope: undefined, canPostTo: NEVER, mySubscribedTopics: [topic] });
        expect(performance.now() - unscopedT0).toBeLessThan(BOUND_MS);
      });
    }

    // The clamp compares a PREFIX, so a pattern that matches inside the first MAX_MATCH_INPUT
    // characters still reports reachable. That is the semantic cost of the bound, pinned here so it
    // is not "fixed" later by silently refusing long topics instead.
    it('still matches on the bounded prefix of an over-long topic', () => {
      const roster = [entry('peer', ['elsewhere'], ['team-.*'])];
      const topic = `team-${'a'.repeat(5_000)}`;
      expect(
        filterReachable(roster, { scope: topic, canPostTo: NEVER, mySubscribedTopics: [] }).map(
          (e) => e.handle,
        ),
      ).toEqual(['peer']);
    });
  });

  it('(e) a benign postTopics pattern still legitimately matches (screen preserves semantics)', () => {
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
