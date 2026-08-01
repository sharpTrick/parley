import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  asTopic,
  type Cursor,
  type FetchRecentResult,
  type Topic,
} from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { SENDER, seqOf, startRig } from './rig.js';

/** The store's bookkeeping lines (identity, served marks, dedup memory) — never records. */
const isHeader = (line: string): boolean => line.startsWith('#');

/**
 * Everything the store keeps BESIDE its file, found by name rather than listed. A fixture that has
 * to stand for state an older version wrote must drop whatever this one keeps out of the file, and
 * a list would go on describing an older shape of that state while silently standing for nothing.
 */
const siblingsOf = (path: string): string[] =>
  readdirSync(dirname(path))
    .filter((f) => f.startsWith(`${basename(path)}.`))
    .map((f) => join(dirname(path), f));

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

  const linesOf = (path: string): string[] => readFileSync(path, 'utf8').trimEnd().split('\n');
  const rewriteWith = (path: string, lines: string[]): void =>
    writeFileSync(path, `${lines.join('\n')}\n`);
  /** Keep every bookkeeping line and drop the last `k` RECORD lines — a stale or rolled-back copy. */
  const dropRecords = (path: string, k: number): void => {
    const lines = linesOf(path);
    const records = lines.filter((l) => !isHeader(l));
    rewriteWith(path, [...lines.filter(isHeader), ...records.slice(0, Math.max(0, records.length - k))]);
  };
  /**
   * Cut the file `k` LINES from the end — a copy of it restored from an earlier one, which is what
   * every ordinary backup, snapshot or rsync of a live store file produces. Swept over every k
   * rather than over named cut points, so that a cut landing between a record and the watermark
   * naming it, ON a record boundary, or several records back, are all rows: only the first of those
   * leaves anything IN the file that disagrees with itself, and a table that hand-picked cut points
   * had rows only for that one.
   */
  const rollBackTail = (path: string, k: number): void => {
    const lines = linesOf(path);
    rewriteWith(path, lines.slice(0, Math.max(0, lines.length - k)));
  };

  const DAMAGE = [
    {
      name: 'a clean restart onto the same file keeps the cursor usable',
      damage: () => undefined,
      outcome: 'serves' as const,
      why: /^$/,
    },
    ...[1, 2, 3].map((k) => ({
      name: `a store file missing its last ${k} record line(s) invalidates the cursor loudly`,
      damage: (path: string) => dropRecords(path, k),
      outcome: 'throws' as const,
      why: /issued by a different observed-message store/,
    })),
    ...[1, 2, 3, 4, 5].map((k) => ({
      name: `a store file rolled back to a copy ${k} line(s) shorter invalidates the cursor loudly`,
      damage: (path: string) => rollBackTail(path, k),
      outcome: 'throws' as const,
      why: /issued by a different observed-message store/,
    })),
    {
      name: 'a store file with a record line corrupted in place invalidates the cursor loudly',
      damage: (path: string) => {
        const lines = linesOf(path);
        const at = lines.findIndex((l) => !isHeader(l));
        lines[at] = `${(lines[at] as string).slice(0, 20)}\u0000not json`;
        rewriteWith(path, lines);
      },
      outcome: 'throws' as const,
      why: /issued by a different observed-message store/,
    },
    {
      name: 'a store file whose tail was cut mid-line invalidates the cursor loudly',
      damage: (path: string) => {
        const raw = readFileSync(path, 'utf8');
        writeFileSync(path, raw.slice(0, raw.length - 8));
      },
      outcome: 'throws' as const,
      why: /issued by a different observed-message store/,
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
   * The second axis: how many messages the REPLACEMENT store observes before the cursor is
   * presented to it. A guard that is only a high-water compare stops firing the moment the new
   * sequence climbs back past the held cursor, so a table that always checks at refill 0 cannot tell
   * a permanent guard from a temporary one — which is how a silent short page (`since` 3 answered
   * with the replacement's 4th message onward, the first three unreachable forever) shipped green,
   * TWICE: once for a store file replaced wholesale, and once for one that merely lost record lines
   * while keeping its identity. Both damage shapes are rows above for that reason, and every depth
   * straddling the held cursor is graded. The invariant per cell is the one this file's header
   * states: every message observed after the cursor, exactly once, or a loud failure. Never a short
   * page.
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
   * The high-water inequality, which the identity check above now stands in front of for every file
   * this build has written: the watermark a damaged file keeps is what turns a lost record into a
   * refused identity, so the plain `since`-above-everything compare is only reachable for a store
   * file written BEFORE the watermark existed. That is the upgrade path, and it is graded at refill
   * 0 only — deliberately, because a file carrying no watermark carries no claim about what it once
   * held, so nothing on disk can tell a truncated legacy file from a short one once new traffic has
   * climbed past the cursor. The rows above are what closes that for every file written since.
   */
  it('refuses a cursor above everything a store file predating the watermark holds', async () => {
    const rig = await startRig();
    const topic = asTopic('-1009800904');
    for (const c of ['a', 'b', 'c', 'd']) await rig.plugin.post(topic, SENDER, c);
    const page = await rig.plugin.fetchRecent({ topic, limit: 100 });
    const cursor = page.messages[2]?.cursor as Cursor;
    expect(seqOf(cursor)).toBe(3);

    await rig.plugin.disconnect();
    // The pre-watermark on-disk state: identity and records, and nothing anywhere — in the file or
    // beside it — that states a high-water.
    const lines = readFileSync(rig.storePath, 'utf8').trimEnd().split('\n');
    const legacy = lines.filter((l) => !l.startsWith('#seq'));
    const kept = [...legacy.filter(isHeader), ...legacy.filter((l) => !isHeader(l)).slice(0, 2)];
    writeFileSync(rig.storePath, `${kept.join('\n')}\n`);
    for (const sibling of siblingsOf(rig.storePath)) unlinkSync(sibling);

    const restarted = await rig.restart();
    await expect(restarted.fetchRecent({ topic, since: cursor })).rejects.toThrow(
      /ahead of every message this store has observed/,
    );
  }, 20_000);

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
