import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { asHandle, asTopic, type Cursor, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { startRig } from './rig.js';

const SENDER = asHandle('me');

/**
 * The cursor is a sequence this PLUGIN generates, so its meaning is only as durable as the store
 * file that mints it — while core persists the cursor an agent holds in its own state directory,
 * with a different lifetime. Every way the store file can change underneath a live cursor must
 * end in one of two places: every message after that cursor is returned exactly once, or the call
 * fails loudly. A permanently short page is the one unacceptable answer — the Bot API has no
 * history endpoint that could ever hand those messages back, so nothing downstream can recover.
 */
describe('telegram cursor across the store lifecycle', () => {
  const heldCursor = async (plugin: TelegramPlugin, topic: Topic): Promise<Cursor> => {
    for (const c of ['a', 'b', 'c']) await plugin.post(topic, SENDER, c);
    const page = await plugin.fetchRecent({ topic, limit: 100 });
    expect(page.messages.map((m) => m.content)).toEqual(['a', 'b', 'c']);
    return page.nextCursor;
  };

  const CASES = [
    {
      name: 'a clean restart onto the same file keeps the cursor usable',
      damage: () => undefined,
      expect: 'serves' as const,
    },
    {
      name: 'a deleted store file invalidates the cursor loudly',
      damage: (path: string) => unlinkSync(path),
      expect: 'throws' as const,
    },
    {
      name: 'a truncated store file invalidates the cursor loudly',
      damage: (path: string) => writeFileSync(path, ''),
      expect: 'throws' as const,
    },
    {
      name: 'a store file replaced by a shorter run invalidates the cursor loudly',
      damage: (path: string) =>
        writeFileSync(
          path,
          `${JSON.stringify({
            chat_id: '-1009800900',
            message_id: 1,
            seq: 1,
            sender: 's',
            content: 'someone else history',
            ts: '2024-01-01T00:00:00.000Z',
          })}\n`,
        ),
      expect: 'throws' as const,
    },
  ];

  it.each(CASES)('$name', async ({ damage, expect: outcome }) => {
    const rig = await startRig();
    const topic = asTopic('-1009800900');
    const cursor = await heldCursor(rig.plugin, topic);

    await rig.plugin.disconnect();
    damage(rig.storePath);
    const restarted = await rig.restart();

    if (outcome === 'throws') {
      await expect(restarted.fetchRecent({ topic, since: cursor })).rejects.toThrow(
        /ahead of every message this store has observed/,
      );
      await expect(
        restarted.fetchRecent({ topic, since: cursor, blockMs: 500 }),
      ).rejects.toThrow(/ahead of every message this store has observed/);
      return;
    }

    for (const c of ['d', 'e', 'f']) await restarted.post(topic, SENDER, c);
    const caughtUp = await restarted.fetchRecent({ topic, since: cursor, limit: 100 });
    expect(caughtUp.messages.map((m) => m.content)).toEqual(['d', 'e', 'f']);
    expect(Number(caughtUp.nextCursor)).toBeGreaterThan(Number(cursor));
  }, 20_000);

  /**
   * The boundary of the staleness check, one line at a time. Every case above damages the file by
   * two or more sequences, so an off-by-one in the comparison is invisible: the likeliest real
   * corruption is a stale backup or a lost compaction rename that costs exactly ONE record.
   * Truncating the store line by line puts the surviving high-water at, above and below the held
   * cursor, and the rule is a single inequality — serve when the store still reaches the cursor,
   * throw the moment it does not.
   */
  const TRUNCATIONS = [-1, 0, 1, 2];

  it.each(TRUNCATIONS)(
    'a store whose high-water sits %i below the held cursor serves or throws accordingly',
    async (below) => {
      const rig = await startRig();
      const topic = asTopic('-1009800904');
      for (const c of ['a', 'b', 'c', 'd']) await rig.plugin.post(topic, SENDER, c);
      const page = await rig.plugin.fetchRecent({ topic, limit: 100 });
      // Hold the third message's cursor, so the file can be truncated to either side of it.
      const cursor = page.messages[2]?.cursor as Cursor;
      expect(Number(cursor)).toBe(3);

      await rig.plugin.disconnect();
      const lines = readFileSync(rig.storePath, 'utf8').trimEnd().split('\n');
      const keep = Number(cursor) - below;
      writeFileSync(rig.storePath, `${lines.slice(0, keep).join('\n')}\n`);
      const restarted = await rig.restart();

      if (below >= 1) {
        await expect(restarted.fetchRecent({ topic, since: cursor })).rejects.toThrow(
          /ahead of every message this store has observed/,
        );
        return;
      }
      const caughtUp = await restarted.fetchRecent({ topic, since: cursor, limit: 100 });
      expect(caughtUp.messages.map((m) => m.content)).toEqual(keep > 3 ? ['d'] : []);
      await restarted.post(topic, SENDER, 'e');
      const after = await restarted.fetchRecent({ topic, since: cursor, limit: 100 });
      expect(after.messages.map((m) => m.content)).toContain('e');
      expect(Number(after.nextCursor)).toBeGreaterThan(Number(cursor));
    },
    20_000,
  );

  /**
   * Retention evicting the record a cursor names is NOT a broken cursor — the sequence space is
   * intact and everything above it is still reachable. A staleness check that fired here would
   * make a busy chat unfetchable.
   */
  it('retention evicting the cursor’s own record still serves everything after it', async () => {
    const rig = await startRig({ observed_retention_per_chat: 2 });
    const topic = asTopic('-1009800901');
    await rig.plugin.post(topic, SENDER, 'a');
    const cursor = (await rig.plugin.fetchRecent({ topic })).nextCursor;
    for (const c of ['b', 'c', 'd']) await rig.plugin.post(topic, SENDER, c);

    const caughtUp = await rig.plugin.fetchRecent({ topic, since: cursor, limit: 100 });
    expect(caughtUp.messages.map((m) => m.content)).toEqual(['c', 'd']);
    expect(Number(caughtUp.nextCursor)).toBeGreaterThan(Number(cursor));
  }, 20_000);

  /**
   * A cursor from a chat with a deeper history is still a cursor THIS store issued, so it must be
   * answered, not refused: the sequence is store-wide, and a quiet chat's records simply all sit
   * below it.
   */
  it('accepts a cursor whose sequence was minted in another chat', async () => {
    const rig = await startRig();
    const busy = asTopic('-1009800902');
    const quiet = asTopic('-1009800903');
    await rig.plugin.post(quiet, SENDER, 'old');
    for (const c of ['a', 'b', 'c', 'd']) await rig.plugin.post(busy, SENDER, c);
    const busyCursor = (await rig.plugin.fetchRecent({ topic: busy, limit: 100 })).nextCursor;

    const page = await rig.plugin.fetchRecent({ topic: quiet, since: busyCursor });
    expect(page.messages).toEqual([]);
    await rig.plugin.post(quiet, SENDER, 'new');
    const after = await rig.plugin.fetchRecent({ topic: quiet, since: busyCursor });
    expect(after.messages.map((m) => m.content)).toEqual(['new']);
  }, 20_000);
});
