import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asHandle,
  asTopic,
  fetchRecentBlocking,
  isBlockingFetchUnsupportedError,
  type Topic,
} from '@sharptrick/parley-core';
import { SqlitePlugin } from '../src/index.js';

/**
 * SQLite is polling-only: there is no read primitive to hand a caller's budget to, so it REFUSES
 * `blockMs` rather than answering as though it had waited. Graded end to end through core's
 * `fetchRecentBlocking` wrapper, which is the one caller that ever passes a budget — the refusal has
 * to reach an embedder off the FIRST call, not be retried, emulated or absorbed into an empty page.
 */
describe('sqlite refuses a block budget', () => {
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

  it('rejects fetchRecent with a blockMs, naming this backend', async () => {
    const t = freshTopic();
    await plugin.post(t, SENDER, 'old');
    const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;

    const refusal = await plugin.fetchRecent({ topic: t, since: tail, blockMs: 5000 }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isBlockingFetchUnsupportedError(refusal)).toBe(true);
    expect(String(refusal)).toContain('parley-sqlite');
  });

  // Fail FAST: the refusal is worth nothing if it costs the caller the wait it refused.
  it('refuses through core long-poll wrapper without spending the budget', async () => {
    const t = freshTopic();
    await plugin.post(t, SENDER, 'old');
    const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;

    const started = Date.now();
    const refusal = await fetchRecentBlocking(
      plugin,
      { topic: t, since: tail },
      { blockMs: 5000, pollIntervalMs: 20 },
    ).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(
      isBlockingFetchUnsupportedError(refusal),
      'core answered a refusing backend with a page instead of propagating the refusal — a caller ' +
        'cannot tell that from a long-poll that timed out empty',
    ).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // The refusal is for the WAIT, not the topic: catch-up is untouched.
  it('still serves the durable read the caller is left with', async () => {
    const t = freshTopic();
    await plugin.post(t, SENDER, 'old');
    const tail = (await plugin.fetchRecent({ topic: t })).nextCursor;
    await plugin.post(t, SENDER, 'fresh');

    const res = await plugin.fetchRecent({ topic: t, since: tail });
    expect(res.messages.map((m) => m.content)).toEqual(['fresh']);
    expect(res.nextCursor).not.toBe(tail);
  });

  // `blockMs: 0` is what core hands every ordinary catch-up. Refusing it would break the read path.
  it('accepts blockMs: 0, which is the ordinary catch-up call', async () => {
    const t = freshTopic();
    await plugin.post(t, SENDER, 'old');
    const res = await plugin.fetchRecent({ topic: t, blockMs: 0 });
    expect(res.messages.map((m) => m.content)).toEqual(['old']);
  });
});
