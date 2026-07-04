import { describe, expect, it } from 'vitest';
import { asBackendMsgId, asCursor, asHandle, asTopic, type Message } from '../message.js';
import {
  computeLive,
  decodePresence,
  encodePresence,
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
): Message {
  return {
    topic: asTopic('parley-presence'),
    senderHandle: asHandle(handle),
    content: encodePresence({ v: 2, kind, at, topics, postTopics }),
    timestamp: new Date(seq * 1000).toISOString(),
    backendMsgId: asBackendMsgId(String(seq)),
    cursor: asCursor(String(seq)),
    mentions: [],
  };
}

describe('encode/decode presence', () => {
  it('round-trips a record, including postTopics', () => {
    const rec: PresenceRecord = {
      v: 2,
      kind: 'heartbeat',
      at: 1234,
      topics: ['ctx-a', 'ctx-b'],
      postTopics: ['ctx-.*', 'general'],
    };
    expect(decodePresence(encodePresence(rec))).toEqual(rec);
  });

  it('defaults postTopics to [] for an old beat that omits it (additive field, no version bump)', () => {
    const rec = decodePresence(JSON.stringify({ v: 2, kind: 'hello', at: 1, topics: ['ctx'] }));
    expect(rec).toEqual({ v: 2, kind: 'hello', at: 1, topics: ['ctx'], postTopics: [] });
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
