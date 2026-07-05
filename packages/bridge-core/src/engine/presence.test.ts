import { describe, expect, it } from 'vitest';
import { asBackendMsgId, asCursor, asHandle, asTopic, type Message } from '../message.js';
import {
  computeLive,
  decodePresence,
  encodePresence,
  MAX_INSTANCE_ID_LEN,
  MAX_RECORD_TOPICS,
  type PresenceKind,
  type PresenceRecord,
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

describe('computeLive', () => {
  const now = 100_000;
  const ttl = 90_000;

  it('lists a handle whose latest beat is a fresh hello/heartbeat, with its topics + postTopics', () => {
    const live = computeLive(
      [beat('claude-a', 'hello', now - 1000, 1, ['ctx-x', 'ctx-y'], ['ctx-.*'])],
      now,
      ttl,
    );
    expect(live).toEqual([
      { handle: 'claude-a', topics: ['ctx-x', 'ctx-y'], postTopics: ['ctx-.*'], lastSeenMs: now - 1000 },
    ]);
  });

  it('takes the latest beat per handle (later cursor wins) and refreshes freshness + topics', () => {
    const msgs = [
      beat('claude-a', 'hello', now - 80_000, 1, ['ctx-a']),
      beat('claude-a', 'heartbeat', now - 1_000, 2, ['ctx-a', 'ctx-b'], ['ctx-.*']),
    ];
    expect(computeLive(msgs, now, ttl)).toEqual([
      { handle: 'claude-a', topics: ['ctx-a', 'ctx-b'], postTopics: ['ctx-.*'], lastSeenMs: now - 1_000 },
    ]);
  });

  it('drops a handle whose latest beat is goodbye', () => {
    const msgs = [
      beat('claude-a', 'heartbeat', now - 1_000, 1),
      beat('claude-a', 'goodbye', now - 500, 2),
    ];
    expect(computeLive(msgs, now, ttl)).toEqual([]);
  });

  it('keeps a handle live when a DIFFERENT instance said goodbye after its hello (stale-goodbye scope, #14)', () => {
    // Relaunch overlap: the new process posts hello (cursor 1); the old process then posts its
    // trailing goodbye (cursor 2, later). Per-instance scoping must NOT let the old instance's
    // goodbye reap the new instance — the handle stays live.
    const msgs = [
      beat('claude-a', 'hello', now - 1_000, 1, ['ctx'], [], 'inst-new'),
      beat('claude-a', 'goodbye', now - 500, 2, ['ctx'], [], 'inst-old'),
    ];
    expect(computeLive(msgs, now, ttl)).toEqual([
      { handle: 'claude-a', topics: ['ctx'], postTopics: [], lastSeenMs: now - 1_000 },
    ]);
  });

  it('unions topics/postTopics across a handle live instances and takes the freshest lastSeenMs', () => {
    const msgs = [
      beat('claude-a', 'hello', now - 2_000, 1, ['ctx-a'], ['a-.*'], 'inst-1'),
      beat('claude-a', 'heartbeat', now - 800, 2, ['ctx-b'], ['b-.*'], 'inst-2'),
    ];
    const live = computeLive(msgs, now, ttl);
    expect(live).toHaveLength(1);
    const entry = live[0]!;
    expect([...entry.topics].sort()).toEqual(['ctx-a', 'ctx-b']);
    expect([...entry.postTopics].sort()).toEqual(['a-.*', 'b-.*']);
    expect(entry.lastSeenMs).toBe(now - 800);
  });

  it('drops a handle whose latest beat is older than the TTL (crash reclaim)', () => {
    const msgs = [beat('claude-a', 'heartbeat', now - ttl, 1)]; // exactly TTL ⇒ not live
    expect(computeLive(msgs, now, ttl)).toEqual([]);
    const stale = [beat('claude-a', 'heartbeat', now - ttl - 1, 1)];
    expect(computeLive(stale, now, ttl)).toEqual([]);
  });

  it('ignores stray non-presence messages on the topic', () => {
    const stray: Message = { ...beat('x', 'hello', now, 1), content: 'plain chatter' };
    expect(computeLive([stray], now, ttl)).toEqual([]);
  });

  it('returns multiple live handles sorted by handle', () => {
    const msgs = [
      beat('human-x', 'heartbeat', now - 1_000, 1),
      beat('claude-b', 'hello', now - 2_000, 2),
      beat('claude-a', 'heartbeat', now - 3_000, 3),
    ];
    expect(computeLive(msgs, now, ttl).map((e) => e.handle)).toEqual([
      'claude-a',
      'claude-b',
      'human-x',
    ]);
  });
});
