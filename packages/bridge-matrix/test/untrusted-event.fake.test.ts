import {
  asCursor,
  asHandle,
  asTopic,
  catchUpTopic,
  type Cursor,
  ReadStateStore,
  SeenSet,
  type Topic,
} from '@sharptrick/parley-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixPlugin } from '../src/index.js';
import { connectFake, FakeSynapse, TOPIC_KEY } from './fake-synapse.js';

/**
 * CLASS: every field this backend reads off the wire is member-controlled JSON that Synapse
 * enforces no schema on. None of it may throw out of a seam call. A throw out of `fetchRecent`
 * bricks startup permanently — `buildBridge` awaits `catchUpAll`, so one hostile event makes every
 * subsequent restart fail until the read-state file is hand-edited — and a throw out of the live
 * path drops the event invisibly.
 */

const TOPIC = 'hostile';

/** Shapes a room member can put on the wire. Each returns the event fields to override. */
const HOSTILE: Record<string, () => Record<string, unknown>> = {
  'body as a number': () => ({ content: { body: 42, [TOPIC_KEY]: TOPIC } }),
  'body as an object': () => ({ content: { body: { nested: true }, [TOPIC_KEY]: TOPIC } }),
  'body as an array': () => ({ content: { body: ['a', 'b'], [TOPIC_KEY]: TOPIC } }),
  'body as a boolean': () => ({ content: { body: true, [TOPIC_KEY]: TOPIC } }),
  'body as null': () => ({ content: { body: null, [TOPIC_KEY]: TOPIC } }),
  'body missing': () => ({ content: { [TOPIC_KEY]: TOPIC } }),
  'content as a string': () => ({ content: 'not-an-object' }),
  'content as null': () => ({ content: null }),
  'content missing': () => ({ content: undefined }),
  'sender missing': () => ({ content: { body: 'x', [TOPIC_KEY]: TOPIC }, sender: undefined }),
  'sender as a number': () => ({ content: { body: 'x', [TOPIC_KEY]: TOPIC }, sender: 7 }),
  'origin_server_ts as a string': () => ({
    content: { body: 'x', [TOPIC_KEY]: TOPIC },
    origin_server_ts: 'yesterday',
  }),
  'origin_server_ts as NaN': () => ({
    content: { body: 'x', [TOPIC_KEY]: TOPIC },
    origin_server_ts: Number.NaN,
  }),
  'origin_server_ts beyond the Date range': () => ({
    content: { body: 'x', [TOPIC_KEY]: TOPIC },
    origin_server_ts: 1e20,
  }),
  'origin_server_ts missing': () => ({
    content: { body: 'x', [TOPIC_KEY]: TOPIC },
    origin_server_ts: undefined,
  }),
  'event_id as a number': () => ({ content: { body: 'x', [TOPIC_KEY]: TOPIC }, event_id: 99 }),
  'event_id missing': () => ({ content: { body: 'x', [TOPIC_KEY]: TOPIC }, event_id: undefined }),
  'type missing': () => ({ content: { body: 'x', [TOPIC_KEY]: TOPIC }, type: undefined }),
};

const rsPath = (): string => join(mkdtempSync(join(tmpdir(), 'parley-mx-')), 'read-state.json');
const WRITER = asHandle('writer');

let fake: FakeSynapse;
beforeEach(() => {
  fake = new FakeSynapse();
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Seed one benign message (so a cursor exists), then every hostile shape, then one more benign. */
async function seed(p: MatrixPlugin, topic: Topic): Promise<Cursor> {
  const first = await p.post(topic, WRITER, 'benign-before');
  for (const shape of Object.values(HOSTILE)) fake.addHostile(shape());
  fake.addMessage(String(topic), 'benign-after');
  return asCursor(String(first));
}

describe('a hostile event never throws out of a read path', () => {
  for (const shared of [true, false]) {
    const label = shared ? 'shared_room' : 'per-topic';

    it(`${label}: fetchRecent with no since resolves and still returns the benign messages`, async () => {
      const p = await connectFake({ shared });
      const topic = asTopic(TOPIC);
      await seed(p, topic);

      const res = await p.fetchRecent({ topic, limit: 100 });

      expect(res.messages.map((m) => m.content)).toContain('benign-after');
      for (const m of res.messages) expect(typeof m.content).toBe('string');
      await p.disconnect();
    });

    it(`${label}: fetchRecent since a cursor resolves and advances past the hostile block`, async () => {
      const p = await connectFake({ shared });
      const topic = asTopic(TOPIC);
      const since = await seed(p, topic);

      const res = await p.fetchRecent({ topic, since, limit: 100 });

      expect(res.messages.map((m) => m.content)).toContain('benign-after');
      expect(String(res.nextCursor)).not.toBe(String(since));
      await p.disconnect();
    });

    it(`${label}: catchUpTopic resumes from the stored cursor instead of bricking startup`, async () => {
      const p = await connectFake({ shared });
      const topic = asTopic(TOPIC);
      const since = await seed(p, topic);
      const readState = new ReadStateStore(rsPath());
      readState.set(topic, since);

      const total = await catchUpTopic({
        plugin: p,
        topic,
        limit: 100,
        readState,
        seen: new SeenSet(),
      });

      expect(total).toBeGreaterThan(0);
      expect(String(readState.get(topic))).not.toBe(String(since));
      await p.disconnect();
    });

    it(`${label}: the live path and the catch-up path agree on which hostile events are messages`, async () => {
      const p = await connectFake({ shared });
      const topic = asTopic(TOPIC);
      const since = asCursor(String(await p.post(topic, WRITER, 'benign-before')));

      const got: string[] = [];
      await p.subscribe(topic, (m) => got.push(m.content));

      for (const shape of Object.values(HOSTILE)) fake.addHostile(shape());
      fake.addMessage(String(topic), 'benign-after');

      await vi.waitFor(() => expect(got).toContain('benign-after'), {
        timeout: 4000,
        interval: 10,
      });

      const caught = await p.fetchRecent({ topic, since, limit: 100 });
      expect(got).toEqual(caught.messages.map((m) => m.content));
      for (const c of got) expect(typeof c).toBe('string');
      await p.disconnect();
    });
  }
});
