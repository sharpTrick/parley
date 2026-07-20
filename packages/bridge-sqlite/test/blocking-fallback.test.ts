import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asHandle, asTopic, fetchRecentBlocking, type Topic } from '@sharptrick/parley-core';
import { SqlitePlugin } from '../src/index.js';

/**
 * SQLite is polling-only by design, so it does NOT block natively — it gets its long-poll from
 * core's generic `fetchRecentBlocking` wrapper. This proves that path end to end against a REAL
 * SqlitePlugin (no plugin change required — issue #20): a blocked fetch wakes promptly on a
 * concurrent post, and returns an empty page with a stable cursor at the timeout.
 */
describe('sqlite + core fetchRecentBlocking (generic fallback, zero plugin change)', () => {
  const SENDER = asHandle('writer');
  let dir: string;
  let plugin: SqlitePlugin;
  let topicSeq = 0;
  const freshTopic = (): Topic => asTopic(`t-${++topicSeq}`);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'parley-block-'));
    plugin = new SqlitePlugin();
    await plugin.connect({ db_path: join(dir, 'p.db'), poll_interval_ms: 20 });
  });
  afterEach(async () => {
    await plugin.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('wakes promptly when a message lands mid-wait', async () => {
    const t = freshTopic();
    await plugin.post(t, SENDER, 'old');
    const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;

    const pending = fetchRecentBlocking(
      plugin,
      { topic: t, since: tail },
      { blockMs: 5000, pollIntervalMs: 20 },
    );
    setTimeout(() => {
      void plugin.post(t, SENDER, 'fresh');
    }, 60);

    const res = await pending;
    expect(res.messages.map((m) => m.content)).toEqual(['fresh']);
    expect(res.nextCursor).not.toBe(tail);
  });

  it('returns an empty page with a stable cursor at the timeout', async () => {
    const t = freshTopic();
    await plugin.post(t, SENDER, 'old');
    const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;

    const started = Date.now();
    const res = await fetchRecentBlocking(
      plugin,
      { topic: t, since: tail },
      { blockMs: 250, pollIntervalMs: 20 },
    );
    expect(res.messages).toEqual([]);
    expect(res.nextCursor).toBe(tail);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });
});
