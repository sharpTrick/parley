import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  asHandle,
  asTopic,
  type Cursor,
  type FetchRecentResult,
  type Topic,
} from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { seqOf, startRig } from './rig.js';

const SENDER = asHandle('me');

/** The store's bookkeeping lines (identity, served marks, dedup memory) — never records. */
const isHeader = (line: string): boolean => line.startsWith('#');

/**
 * The cursor is a sequence this PLUGIN generates, so its meaning is only as durable as the store
 * file that mints it — while core persists the cursor an agent holds in its own state directory,
 * with a different lifetime. Every way the store file can change underneath a live cursor must
 * end in one of two places: every message after that cursor is returned exactly once, or the call
 * fails loudly. A permanently short page is the one unacceptable answer — the Bot API has no
 * history endpoint that could ever hand those messages back, so nothing downstream can recover.
 */
describe('telegram cursor across the store lifecycle', () => {
  const HELD = ['a', 'b', 'c'];

  const heldCursor = async (plugin: TelegramPlugin, topic: Topic): Promise<Cursor> => {
    for (const c of HELD) await plugin.post(topic, SENDER, c);
    const page = await plugin.fetchRecent({ topic, limit: 100 });
    expect(page.messages.map((m) => m.content)).toEqual(HELD);
    return page.nextCursor;
  };

  const DAMAGE = [
    {
      name: 'a clean restart onto the same file keeps the cursor usable',
      damage: () => undefined,
      outcome: 'serves' as const,
      why: /^$/,
    },
    {
      name: 'a deleted store file invalidates the cursor loudly',
      damage: (path: string) => unlinkSync(path),
      outcome: 'throws' as const,
      why: /issued by a different observed-message store/,
    },
    {
      name: 'a truncated store file invalidates the cursor loudly',
      damage: (path: string) => writeFileSync(path, ''),
      outcome: 'throws' as const,
      why: /issued by a different observed-message store/,
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
      outcome: 'throws' as const,
      why: /issued by a different observed-message store/,
    },
    {
      name: 'a store file whose identity line was lost invalidates the cursor loudly',
      damage: (path: string) =>
        writeFileSync(
          path,
          `${readFileSync(path, 'utf8')
            .trimEnd()
            .split('\n')
            .filter((l) => !isHeader(l))
            .join('\n')}\n`,
        ),
      outcome: 'throws' as const,
      why: /issued by a different observed-message store/,
    },
  ];

  /**
   * The second axis, and the one the table used to be missing: how many messages the REPLACEMENT
   * store observes before the cursor is presented to it. A guard that is only a high-water compare
   * stops firing the moment the new sequence climbs back past the held cursor, so a table that
   * always checks at refill 0 cannot tell a permanent guard from a temporary one — which is how a
   * silent short page (`since` 3 answered with the replacement's 4th message onward, the first
   * three unreachable forever) shipped green. Every depth straddling the held cursor is graded, and
   * the invariant per cell is the one this file's header states: every message observed after the
   * cursor, exactly once, or a loud failure. Never a short page.
   */
  const REFILLS = [0, 1, HELD.length - 1, HELD.length, HELD.length + 5];

  const CELLS = DAMAGE.flatMap((damage) => REFILLS.map((refill) => ({ ...damage, refill })));

  it.each(CELLS)(
    '$name, with $refill messages observed after the damage',
    async ({ damage, outcome, why, refill }) => {
      const rig = await startRig();
      const topic = asTopic('-1009800900');
      const cursor = await heldCursor(rig.plugin, topic);

      await rig.plugin.disconnect();
      damage(rig.storePath);
      const restarted = await rig.restart();
      const refilled = Array.from({ length: refill }, (_, i) => `n${i + 1}`);
      for (const c of refilled) await restarted.post(topic, SENDER, c);

      // Both catch-up shapes: a blocking call must reach the same verdict, never park past a
      // cursor it should have refused and then answer out of the replacement's sequence space.
      for (const blockMs of [undefined, 500]) {
        const answer = await restarted
          .fetchRecent({ topic, since: cursor, limit: 100, blockMs })
          .then(
            (page) => page,
            (err: unknown) => err as Error,
          );
        if (outcome === 'throws') {
          expect(answer).toBeInstanceOf(Error);
          expect((answer as Error).message).toMatch(why);
          continue;
        }
        const page = answer as FetchRecentResult;
        expect(page.messages.map((m) => m.content)).toEqual(refilled);
        expect(seqOf(page.nextCursor)).toBeGreaterThanOrEqual(seqOf(cursor));
      }
    },
    20_000,
  );

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
      expect(seqOf(cursor)).toBe(3);

      await rig.plugin.disconnect();
      const lines = readFileSync(rig.storePath, 'utf8').trimEnd().split('\n');
      // Keep the bookkeeping lines: dropping the identity line makes this a DIFFERENT store file,
      // which the case above already grades — here the file must stay the same one, so that what
      // is under test is the high-water inequality and not the identity check standing in for it.
      const headers = lines.filter(isHeader);
      const keep = Number(seqOf(cursor)) - below;
      const kept = [...headers, ...lines.filter((l) => !isHeader(l)).slice(0, keep)];
      writeFileSync(rig.storePath, `${kept.join('\n')}\n`);
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
      expect(seqOf(after.nextCursor)).toBeGreaterThan(seqOf(cursor));
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
    expect(seqOf(caughtUp.nextCursor)).toBeGreaterThan(seqOf(cursor));
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
