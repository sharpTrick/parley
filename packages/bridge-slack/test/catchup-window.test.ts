/**
 * CLASS: catch-up must make progress whatever the subtype mix.
 *
 * `conversations.history` returns system/mutation records (`channel_join`, …) interleaved with the
 * plain messages the seam surfaces. Every window-trimming decision inside `runFetch` must therefore
 * be made on SURFACED messages, never on raw entries — a trim that keeps raw entries can retain a
 * tail that filters down to nothing, and an empty page whose `nextCursor` equals `since` is a
 * livelock: the caller feeds the same cursor back forever and the messages behind the system
 * records are never delivered.
 *
 * The table below crosses channel layouts (runs of plain / system records) with every `since` mode
 * and a range of `limit`s, and drains each one by looping on `nextCursor` — the exact loop core's
 * catch-up runs. A layout that starves shows up as a drain that ends early, missing messages.
 */
import { asCursor, asTopic, type Cursor, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { compareTs, SlackPlugin } from '../src/index.js';
import { FakeSlack } from './fake-slack.js';

interface Run {
  n: number;
  subtype?: string;
}

/** Layouts chosen so the oldest raw tail is system-heavy at, below and above the trim threshold. */
const LAYOUTS: Array<{ name: string; runs: Run[] }> = [
  { name: 'leading-system-heavy', runs: [{ n: 330, subtype: 'channel_join' }, { n: 40 }] },
  { name: 'trailing-system-heavy', runs: [{ n: 40 }, { n: 330, subtype: 'channel_join' }] },
  { name: 'system-sandwich', runs: [{ n: 160, subtype: 'channel_join' }, { n: 20 }, { n: 160, subtype: 'message_changed' }, { n: 20 }] },
  {
    name: 'alternating',
    runs: Array.from({ length: 120 }, (_, i) =>
      i % 2 === 0 ? { n: 3, subtype: 'channel_join' } : { n: 1 },
    ),
  },
  { name: 'all-system', runs: [{ n: 320, subtype: 'channel_join' }] },
  { name: 'all-plain', runs: [{ n: 120 }] },
  { name: 'straddles-page-and-limit', runs: [{ n: 51 }, { n: 249, subtype: 'channel_join' }, { n: 49 }, { n: 1, subtype: 'channel_leave' }] },
];

const SINCE_MODES = ['none', 'zero', 'mid'] as const;
const LIMITS = [1, 10, 100];

function entriesOf(runs: Run[]): Array<{ text: string; subtype?: string }> {
  const out: Array<{ text: string; subtype?: string }> = [];
  for (const run of runs) {
    for (let i = 0; i < run.n; i++) {
      const e: { text: string; subtype?: string } = { text: `m${out.length}` };
      if (run.subtype !== undefined) e.subtype = run.subtype;
      out.push(e);
    }
  }
  return out;
}

/** Loop on `nextCursor` exactly as core's catch-up does; fail loudly if it never terminates. */
async function drain(
  plugin: SlackPlugin,
  topic: Topic,
  since: Cursor | undefined,
  limit: number,
): Promise<{ contents: string[]; cursors: string[] }> {
  const contents: string[] = [];
  const cursors: string[] = [];
  let cursor = since;
  for (let i = 0; i < 500; i++) {
    const page: { messages: Array<{ content: string }>; nextCursor: Cursor } =
      await plugin.fetchRecent(cursor === undefined ? { topic, limit } : { topic, since: cursor, limit });
    cursors.push(String(page.nextCursor));
    cursor = page.nextCursor;
    if (page.messages.length === 0) return { contents, cursors };
    contents.push(...page.messages.map((m) => m.content));
  }
  throw new Error('drain never terminated');
}

describe('slack catch-up window arithmetic', () => {
  for (const layout of LAYOUTS) {
    for (const sinceMode of SINCE_MODES) {
      for (const limit of LIMITS) {
        it(`drains ${layout.name} / since=${sinceMode} / limit=${limit} to completion`, async () => {
          const fake = await FakeSlack.start();
          const plugin = new SlackPlugin();
          await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test' });
          try {
            const topic = asTopic('C0LAYOUT');
            const seeded = fake.seed(topic, entriesOf(layout.runs));
            const plain = seeded.filter((m) => m.subtype === undefined);

            const midTs = seeded[Math.floor(seeded.length / 2)]!.ts;
            const since =
              sinceMode === 'none' ? undefined : asCursor(sinceMode === 'zero' ? '0' : midTs);

            const { contents, cursors } = await drain(plugin, topic, since, limit);

            // Without `since` the first page is the NEWEST `limit`; with one, every plain message
            // strictly after it must arrive — in order, exactly once.
            const expected =
              sinceMode === 'none'
                ? plain.slice(-limit).map((m) => m.text)
                : plain.filter((m) => compareTs(m.ts, String(since)) > 0).map((m) => m.text);
            expect(contents).toEqual(expected);

            for (let i = 1; i < cursors.length; i++) {
              expect(compareTs(cursors[i]!, cursors[i - 1]!)).toBeGreaterThanOrEqual(0);
            }
            // A drained `since` walk saw every entry above it, so the cursor must end ABOVE the
            // trailing system records too — otherwise each later catch-up re-walks them forever.
            if (sinceMode !== 'none') expect(cursors.at(-1)).toBe(seeded.at(-1)!.ts);
          } finally {
            await plugin.disconnect();
            await fake.close();
          }
        });
      }
    }
  }
});
