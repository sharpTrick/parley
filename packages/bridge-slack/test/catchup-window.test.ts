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
import { DEFAULT_PAGE_SIZE as FAKE_PAGE_SIZE, type OldestWindow } from './fake-slack.js';
import { capture, settleWithin, startSlack } from './harness.js';

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
 * CLASS: a vendor promise the plugin resolves entirely server-side and never checks. `since` is the
 * seam's EXCLUSIVE floor, and the only thing enforcing it was `conversations.history {oldest}` —
 * the one contract in the walk that is not verified, while its siblings (newest-first order, a
 * repeated page cursor, the page ceiling, a usable `ts`) all throw. Slack is hosted SaaS and cannot
 * be probed, so which reading it holds is not knowable from here; what IS knowable is that the
 * plugin must answer the same seam contract under every reading. Each row below runs the drain core
 * runs against a server that honours `oldest` as documented, one that counts the boundary entry as
 * inside it, and one that ignores it outright — a page below the caller's cursor reaches a trim and
 * a slice that both DISCARD on position, so the page comes back as the OLDEST entries in the
 * channel and `nextCursor` comes to rest at or below the cursor it was handed: the catch-up then
 * returns that same page forever and the newer history is never delivered.
 */
const WINDOW_READINGS: OldestWindow[] = ['as-asked', 'inclusive', 'ignored'];
const WINDOW_LIMITS = [1, 4];

describe('slack catch-up holds the exclusive window whatever the server does with `oldest`', () => {
  for (const reading of WINDOW_READINGS) {
    for (const limit of WINDOW_LIMITS) {
      it(`drains past a server whose \`oldest\` is ${reading} (limit=${limit})`, async () => {
        const { fake, plugin, cleanup } = await startSlack({
          appToken: null,
          arm: (f) => f.setOldestWindow(reading),
        });
        try {
          const topic = asTopic('C0WINDOWREAD');
          const seeded = fake.seed(
            topic,
            Array.from({ length: 12 }, (_, i) => ({ text: `m${i}` })),
          );
          // A floor INSIDE the channel, so a reading that widens the window has older history to
          // hand back and a boundary entry to repeat.
          const floor = seeded[3]!.ts;
          const above = seeded.slice(4);

          const { contents, cursors } = await drain(plugin, topic, asCursor(floor), limit);

          expect(contents, 'the drain surfaced exactly the history above the floor').toEqual(
            above.map((m) => m.text),
          );
          for (const cursor of cursors) {
            expect(
              compareTs(cursor, floor),
              `published cursor ${cursor} is at or below the floor it was handed`,
            ).toBeGreaterThan(0);
          }
          expect(cursors, 'the cursor never steps backwards').toEqual(
            [...cursors].sort((a, b) => compareTs(a, b)),
          );
        } finally {
          await cleanup();
        }
      });
    }
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

/**
 * The same CLASS, one field wider. `limit` is a number the seam hands this plugin with no bound —
 * `fetchRecent` is public API, and only the MCP tool path upstream refuses a hostile one — and a
 * non-finite one reaches the page walk's own arithmetic, where it neither fills a window nor ends
 * it, and reaches `slice(0, NaN)`, which is an EMPTY page a caller cannot tell from "nothing new".
 * So the rows grade three things only an argument can break: whether the call SETTLES, whether it
 * still answers with the history it has, and how many reads it spent getting there.
 *
 * The fixture spans SEVERAL server pages, so `limit` can move the page count at all: over a
 * single-page one the walk ends before any of this arithmetic runs, every cell costs exactly one
 * read, and the cost half of this table grades nothing — which is what it did.
 */
const ARG_LIMITS = [-5, 0, 1, Number.NaN, Number.POSITIVE_INFINITY, undefined];
const SETTLE_MS = 3000;
/** Several server pages' worth, so the walk's page count is a function of the argument. */
const PAGED_VOLUME = FAKE_PAGE_SIZE * 3 - 10;
const PAGES_OVER_FIXTURE = Math.ceil(PAGED_VOLUME / FAKE_PAGE_SIZE);
/** The same fixture ending exactly ON a page boundary — the arithmetic's only edge case. */
const EXACT_PAGES = 3;
const EXACT_VOLUME = FAKE_PAGE_SIZE * EXACT_PAGES;

describe('slack fetchRecent settles on every numeric seam argument, at bounded request cost', () => {
  /** Reads each cell spent, so the table can prove its own cost axis is not flat. */
  const spent: number[] = [];

  for (const limit of ARG_LIMITS) {
    for (const sinceMode of ['none', 'zero', 'tail'] as const) {
      it(`limit=${String(limit)} / since=${sinceMode}`, async () => {
        const { fake, plugin, cleanup } = await startSlack({ appToken: null });
        try {
          const topic = asTopic('C0ARGS');
          const seeded = fake.seed(
            topic,
            Array.from({ length: PAGED_VOLUME }, (_, i) => ({ text: `m${i}` })),
          );
          const since = { none: undefined, zero: '0', tail: seeded.at(-1)!.ts }[sinceMode];
          const args = {
            topic,
            ...(limit === undefined ? {} : { limit }),
            ...(since === undefined ? {} : { since: asCursor(since) }),
          };

          const before = fake.hits('conversations.history');
          const settled = await settleWithin(capture(plugin.fetchRecent(args)), SETTLE_MS);
          const reads = fake.hits('conversations.history') - before;
          spent.push(reads);

          expect(settled.status, `never settled inside ${SETTLE_MS}ms`).toBe('fulfilled');
          // A hostile `limit` may narrow the page; it may never turn history into "nothing new".
          // `since=tail` is the one cell with nothing above the floor, so it alone answers empty.
          const returned = settled.status === 'fulfilled' ? settled.value.messages.length : -1;
          expect(
            returned > 0,
            'a page a caller cannot tell from "nothing new", on a topic that has history',
          ).toBe(sinceMode !== 'tail');
          expect(reads, 'history reads for one call').toBeLessThanOrEqual(PAGES_OVER_FIXTURE);
        } finally {
          await cleanup();
        }
      });
    }
  }

  // The cost half of the table above is only evidence while some argument can MOVE the page count.
  // Every cell reading exactly one page is indistinguishable from a ceiling nothing can reach.
  it('some argument costs more than one read, so the ceiling above grades something', () => {
    expect(spent.length, 'cells that ran').toBe(ARG_LIMITS.length * 3);
    // REACHED, not merely approached: `PAGED_VOLUME` is deliberately not a page multiple, so a
    // ceiling one read above the walk's own cost is a ceiling no cell can ever touch and a
    // regression spending an extra read passes the table written to catch it.
    expect(Math.max(...spent), 'the most any cell spent').toBe(PAGES_OVER_FIXTURE);
    expect(Math.min(...spent), 'the least any cell spent').toBe(1);
  });

  /**
   * The page-count arithmetic's one edge: a fixture ending exactly ON a page boundary. Slack — and
   * this fake — answer the last FULL page with `has_more: false`, so exhaustion costs no extra read
   * and the walk is `pages`, not `pages + 1`. A walk that treats a full page as "there may be more"
   * spends that extra read, which every cell above is blind to because `PAGED_VOLUME` ends short.
   */
  it('costs exactly its page count over a fixture that ends on a page boundary', async () => {
    const { fake, plugin, cleanup } = await startSlack({ appToken: null });
    try {
      const topic = asTopic('C0EXACT');
      fake.seed(topic, Array.from({ length: EXACT_VOLUME }, (_, i) => ({ text: `m${i}` })));
      const before = fake.hits('conversations.history');
      const page = await plugin.fetchRecent({
        topic,
        since: asCursor('0'),
        limit: EXACT_VOLUME,
      });
      const reads = fake.hits('conversations.history') - before;
      expect(page.messages.length, 'the whole fixture').toBe(EXACT_VOLUME);
      expect(reads, 'history reads over a page-multiple fixture').toBe(EXACT_PAGES);
    } finally {
      await cleanup();
    }
  });
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
