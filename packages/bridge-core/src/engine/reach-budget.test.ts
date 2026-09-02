import { describe, expect, it } from 'vitest';
import { asHandle } from '../message.js';
import { MAX_RECORD_TOPICS } from './presence-beat.js';
import { filterReachable, type ReachBudget } from './presence-reach.js';
import type { RosterEntry } from './presence.js';

/**
 * The reach ALLOWANCE's sharing rule, graded without a clock.
 *
 * Its only other grader built pressure out of wall-clock cost, and that cost collapses by orders of
 * magnitude once V8 has tiered the regex engine up: the same hostile page that reddens one test in
 * isolation costs nothing measurable inside a warm run, so handing the allowance out FIRST-COME —
 * the regression the rule exists to prevent — left all 3283 `bridge-core` tests green. A budget test
 * whose pressure is timing-derived is unfalsifiable exactly where it matters.
 *
 * So the meter is injected and every unit of work costs exactly one unit. The three rules the
 * production allowance rests on then each have a cell that fails deterministically:
 *
 *  - **shared fairly, not first-come** — a saturating prefix must not decide the verdict for the
 *    entries behind it;
 *  - **separate per direction** — a page that exhausts the outbound allowance must not switch the
 *    inbound one off;
 *  - **clipped at all** — the prefix that overspends must be cut, and say so.
 */
describe('the reach allowance is shared fairly, per direction, and actually clipped', () => {
  /** The caller's one subscribed topic — short, so no input-length refusal is in play. */
  const MINE = 'ctx-mine';

  /**
   * A meter that charges exactly one unit per unit of work: `budget` reads it once before and once
   * after, so a clock that advances on every read prices every match identically.
   */
  function unitMeter(totalMs: number): ReachBudget {
    let ticks = 0;
    return { totalMs, now: () => ++ticks };
  }

  function entry(handle: string, topics: string[], postTopics: string[]): RosterEntry {
    return { handle: asHandle(handle), online: true, topics, postTopics, lastSeenMs: 0 };
  }

  /**
   * A full record's worth of sources that never match — derived from the per-record cap, so that
   * widening the cap re-derives a saturating entry rather than leaving a hard-coded one behind.
   */
  const bank = (seed: number, kind: 'topic' | 'pattern'): string[] =>
    Array.from({ length: MAX_RECORD_TOPICS }, (_u, i) => `${kind}-no-match-${seed}-${i}`);

  type Inflated = 'inbound' | 'outbound';
  type Position = 'first' | 'middle' | 'last';
  type Reach = 'explicit shared topic' | 'pattern-only';

  const PREFIXES = [1, 4, 16];
  const INFLATED: Inflated[] = ['inbound', 'outbound'];
  const POSITIONS: Position[] = ['first', 'middle', 'last'];
  const REACHES: Reach[] = ['explicit shared topic', 'pattern-only'];

  const CELLS = PREFIXES.flatMap((prefix) =>
    INFLATED.flatMap((inflated) =>
      POSITIONS.flatMap((position) =>
        REACHES.map((reach) => ({ prefix, inflated, position, reach })),
      ),
    ),
  );

  it.each(
    CELLS.map(
      (c) =>
        [`${c.prefix} ${c.inflated}-inflated ahead of a ${c.reach} peer placed ${c.position}`, c] as const,
    ),
  )('%s', (_label, cell) => {
    const benignAt =
      cell.position === 'first' ? 0 : cell.position === 'last' ? cell.prefix : cell.prefix >> 1;
    const roster: RosterEntry[] = [];
    for (let i = 0; i <= cell.prefix; i++) {
      if (i === benignAt) {
        roster.push(
          cell.reach === 'explicit shared topic'
            ? entry('colleague', [MINE], [])
            : entry('colleague', ['their-own'], [`${MINE.slice(0, 4)}.*`]),
        );
        continue;
      }
      roster.push(
        cell.inflated === 'inbound'
          ? entry(`hostile-${i}`, ['their-own'], bank(i, 'pattern'))
          : entry(`hostile-${i}`, bank(i, 'topic'), []),
      );
    }

    // Two units per entry: every entry's fair share stays large enough to answer a peer that
    // matches on its first source, and small enough that a full bank saturates it.
    const entries = cell.prefix + 1;
    let clipped = 0;
    const kept = filterReachable(roster, {
      canPostTo: (t) => t === MINE,
      mySubscribedTopics: [MINE],
      onReachClipped: () => {
        clipped++;
      },
      reachBudget: unitMeter(2 * entries),
    });

    expect(
      kept.map((e) => e.handle),
      'the saturating prefix spent the allowance the peer behind it needed',
    ).toContain('colleague');
    expect(kept, 'a rule that returned everyone would satisfy the assertion above').toHaveLength(1);
    expect(
      clipped,
      'no entry was clipped, so nothing is bounding what one page may spend',
    ).toBe(cell.prefix);
  });

  /**
   * The two directions are metered separately. Only an outbound-inflated page can prove it: it
   * leaves the inbound allowance untouched, so a peer reachable ONLY inbound still answers. One
   * meter shared across both directions makes it vanish.
   */
  it.each(PREFIXES)('%i entries saturating the outbound allowance leave the inbound one intact', (prefix) => {
    const roster = Array.from({ length: prefix }, (_u, i) =>
      entry(`hostile-${i}`, bank(i, 'topic'), []),
    );
    roster.push(entry('colleague', ['their-own'], [`${MINE.slice(0, 4)}.*`]));

    const kept = filterReachable(roster, {
      canPostTo: (t) => t === MINE,
      mySubscribedTopics: [MINE],
      onReachClipped: () => {},
      reachBudget: unitMeter(2 * (prefix + 1)),
    });

    expect(
      kept.map((e) => e.handle),
      'a peer reachable only inbound vanished when the outbound direction was saturated',
    ).toEqual(['colleague']);
  });

  /**
   * The allowance is spent, not merely armed: a benign page of the same size — where no entry
   * outspends its share — is answered in full and reports no clipping at all.
   */
  it('a benign page of the same size is neither clipped nor trimmed', () => {
    const entries = 17;
    const roster = Array.from({ length: entries }, (_u, i) => entry(`peer-${i}`, [MINE], []));
    let clipped = 0;
    const kept = filterReachable(roster, {
      canPostTo: (t) => t === MINE,
      mySubscribedTopics: [MINE],
      onReachClipped: () => {
        clipped++;
      },
      reachBudget: unitMeter(2 * entries),
    });
    expect(kept).toHaveLength(entries);
    expect(clipped).toBe(0);
  });
});
