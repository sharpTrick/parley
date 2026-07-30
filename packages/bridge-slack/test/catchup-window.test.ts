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
import { startSlack } from './harness.js';

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

/**
 * The page cap Slack applies to a commercially distributed non-Marketplace app — far below the
 * `limit` the plugin asks for, and served without saying so. The table above grades the window
 * arithmetic across layouts at the default page size; this grades the drain at the one page cap the
 * README makes a claim about, so that claim is executable rather than prose.
 */
const REDUCED_TIER_PAGE = 15;

describe('slack catch-up drains against a server capped far below the requested limit', () => {
  it(`drains a page-straddling layout at pageSize=${REDUCED_TIER_PAGE}`, async () => {
    const { fake, plugin, cleanup } = await startSlack({
      pageSize: REDUCED_TIER_PAGE,
      appToken: null,
    });
    try {
      const topic = asTopic('C0PAGECAP');
      const layout = LAYOUTS.find((l) => l.name === 'straddles-page-and-limit')!;
      const seeded = fake.seed(topic, entriesOf(layout.runs));
      const plain = seeded.filter((m) => m.subtype === undefined);

      const { contents, cursors } = await drain(plugin, topic, asCursor('0'), 10);

      expect(contents).toEqual(plain.map((m) => m.text));
      // A drained `since` walk saw every entry above it, so the cursor ends above the trailing system
      // records however the pages happened to be cut.
      expect(cursors.at(-1)).toBe(seeded.at(-1)!.ts);
    } finally {
      await cleanup();
    }
  });
});

/**
 * The layout the drain table cannot grade: a channel where NOTHING is surfacable. Every page is
 * fetched and discarded, so the walk's only output is the position it reached — and a walk that
 * reports `'0'` instead makes core store `'0'`, so the next catch-up pays for the whole channel
 * again, forever. A cursor assertion alone would pass a cursor that merely LOOKS advanced, so the
 * cost of the second call is asserted in requests.
 */
describe('slack catch-up publishes the position an exhaustive walk reached', () => {
  for (const sinceMode of ['none', 'zero'] as const) {
    it(`a walk that surfaces nothing still advances (since=${sinceMode})`, async () => {
      const { fake, plugin, cleanup } = await startSlack({ appToken: null });
      try {
        const topic = asTopic('C0UNSURFACED');
        const seeded = fake.seed(topic, entriesOf([{ n: 300, subtype: 'channel_join' }]));

        const first = await plugin.fetchRecent(
          sinceMode === 'none' ? { topic, limit: 100 } : { topic, since: asCursor('0'), limit: 100 },
        );
        const walked = fake.hits('conversations.history');

        expect(first.messages).toEqual([]);
        expect(String(first.nextCursor)).toBe(seeded.at(-1)!.ts);
        // The walk really did read the whole channel — otherwise the cursor above is a guess.
        expect(walked, 'pages walked').toBeGreaterThan(1);

        const second = await plugin.fetchRecent({ topic, since: first.nextCursor, limit: 100 });
        expect(second.messages).toEqual([]);
        expect(fake.hits('conversations.history') - walked, 'pages re-walked').toBe(1);
      } finally {
        await cleanup();
      }
    });
  }
});

/**
 * CLASS: a seam argument used in arithmetic without a floor. `FetchRecentArgs.limit` is declared
 * `number | undefined` with no lower bound, and the window is cut with `slice(-limit)` — where
 * `slice(-0)` is `slice(0)`, the WHOLE page, and `slice(5)` for -5 is an arbitrary middle of it.
 * Core's own schema happens to clamp it, but the plugin's contract is the plugin's to keep. The rows
 * below start BELOW 1, which is where the existing LIMITS table cannot look, and each one is drained
 * afterwards so a floor that merely truncates cannot also lose the messages it withheld.
 */
const SEEDED = 30;
const LIMIT_ROWS = [-5, -1, 0, 1, 2, undefined];

describe('slack fetchRecent floors a non-positive limit', () => {
  for (const limit of LIMIT_ROWS) {
    for (const sinceMode of ['none', 'zero'] as const) {
      it(`limit=${String(limit)} / since=${sinceMode} returns at most max(1, limit) and stays replayable`, async () => {
        const { fake, plugin, cleanup } = await startSlack({ appToken: null });
        try {
          const topic = asTopic('C0LIMIT');
          const seeded = fake.seed(
            topic,
            Array.from({ length: SEEDED }, (_, i) => ({ text: `m${i}` })),
          );
          const args = { topic, ...(limit === undefined ? {} : { limit }) };
          const since = sinceMode === 'none' ? undefined : asCursor('0');

          const page = await plugin.fetchRecent(since === undefined ? args : { ...args, since });

          const ceiling = limit === undefined ? SEEDED : Math.max(1, limit);
          expect(page.messages.length, 'page size').toBeLessThanOrEqual(ceiling);
          expect(page.messages.length, 'page size').toBeGreaterThan(0);
          // Without `since` the page is the NEWEST it may carry; with one, the OLDEST above the floor.
          const texts = seeded.map((m) => m.text);
          expect(page.messages.map((m) => m.content)).toEqual(
            sinceMode === 'none'
              ? texts.slice(-page.messages.length)
              : texts.slice(0, page.messages.length),
          );

          // A floor that truncates must not also swallow: the published cursor still reaches the rest.
          const rest = await plugin.fetchRecent({ topic, since: page.nextCursor, limit: SEEDED });
          const seen = [...page.messages.map((m) => m.content), ...rest.messages.map((m) => m.content)];
          expect(new Set(seen).size, 'no message delivered twice').toBe(seen.length);
          if (sinceMode === 'zero') expect(seen).toEqual(texts);
        } finally {
          await cleanup();
        }
      });
    }
  }
});

describe('slack catch-up window arithmetic', () => {
  for (const layout of LAYOUTS) {
    for (const sinceMode of SINCE_MODES) {
      for (const limit of LIMITS) {
        it(`drains ${layout.name} / since=${sinceMode} / limit=${limit} to completion`, async () => {
          const { fake, plugin, cleanup } = await startSlack({ appToken: null });
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
            // A drain that ran to exhaustion saw every entry above its floor, so the cursor must end
            // ABOVE the trailing system records — otherwise each later catch-up re-walks them
            // forever. The no-`since` walk reaches exhaustion too, so it owes the same answer.
            expect(cursors.at(-1)).toBe(seeded.at(-1)!.ts);
          } finally {
            await cleanup();
          }
        });
      }
    }
  }
});
