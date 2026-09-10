import { MAX_TIMER_MS } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { MAX_DIALERS } from '../src/config.js';
import {
  BACKOFF_BASE_MS,
  dialBudgetFor,
  IDENTIFY_QUOTA_PER_DAY,
  IDENTIFY_QUOTA_WINDOW_MS,
  RECONNECT_CAP_MS,
  STABLE_CONNECTION_MS,
} from '../src/index.js';

/**
 * A fleet sharing one bot token re-IDENTIFYs fewer times in a day than Discord allows that token.
 *
 * The allowance is the VENDOR's, so {@link IDENTIFY_QUOTA_PER_DAY} is the only place this package
 * can hold it: nothing here can measure it, and the penalty for exceeding it is a bot-token reset
 * that breaks every instance sharing the bot until a human re-provisions it. Every pacing figure
 * the ladder applies is chosen against that number, so each is checked against it here rather than
 * against a figure copied next to it.
 *
 * The precondition: the domain below is {@link MAX_DIALERS}, the bound `connect()` enforces — so
 * widening what the plugin accepts widens what this file grades, instead of leaving the newly
 * accepted fleet sizes ungraded. That the bound is the largest fan-out whose ceiling a timer can
 * still hold is asserted too, because a wrapped ceiling fires at 1 ms and the argument below is
 * then about a delay nothing applies.
 *
 * Why both figures: the ladder's ceiling paces a gateway that never comes up, and the stability
 * window paces one that comes up and drops — that second path FORGIVES the ladder, so it re-dials
 * from the first rung and the ceiling never enters into it.
 *
 * Proof it can fail: halve `RECONNECT_CAP_MS`, or restore `STABLE_CONNECTION_MS` to a minute, or
 * make `MAX_DIALERS` a `Math.ceil`, and these red.
 */

/** The whole accepted domain at its edges, plus the interior, so no row sits only on a boundary. */
const DIALERS = [
  1,
  2,
  3,
  Math.floor(MAX_DIALERS / 2),
  MAX_DIALERS - 1,
  MAX_DIALERS,
] as const;

/**
 * IDENTIFYs a fleet of `dialers` spends in a day when every socket fails the same way forever.
 * Each instance dials once per `spacingMs`, and the quota counts the token's, so the fleet's total
 * is what has to fit.
 */
const fleetIdentifiesPerDay = (dialers: number, spacingMs: number): number =>
  (dialers * IDENTIFY_QUOTA_WINDOW_MS) / spacingMs;

describe('the reconnect ladder cannot spend one bot token past its IDENTIFY quota', () => {
  it('grades the whole domain connect() accepts, and stops where a timer stops holding it', () => {
    expect(Math.max(...DIALERS)).toBe(MAX_DIALERS);
    expect(new Set(DIALERS).size, 'a duplicated fan-out silently shrinks the domain').toBe(
      DIALERS.length,
    );
    expect(
      dialBudgetFor(MAX_DIALERS).reconnectCapMs,
      'the accepted ceiling is a delay setTimeout cannot hold, so it fires at 1 ms',
    ).toBeLessThanOrEqual(MAX_TIMER_MS);
    expect(
      dialBudgetFor(MAX_DIALERS + 1).reconnectCapMs,
      'a larger fan-out would still arm, so the bound refuses fleets it has no reason to',
    ).toBeGreaterThan(MAX_TIMER_MS);
  });

  it.each(DIALERS)(
    'a fleet of %i on one token stays under quota when the gateway never comes up',
    (dialers) => {
      const { reconnectCapMs } = dialBudgetFor(dialers);
      expect(
        fleetIdentifiesPerDay(dialers, reconnectCapMs),
        `${dialers} instance(s) paced by a ${reconnectCapMs}ms ceiling outrun the token's quota`,
      ).toBeLessThan(IDENTIFY_QUOTA_PER_DAY);
    },
  );

  it.each(DIALERS)(
    'a fleet of %i on one token stays under quota when the gateway drops just after every READY',
    (dialers) => {
      const { stableConnectionMs } = dialBudgetFor(dialers);
      // The worst cycle this path allows: up just long enough to be forgiven, then straight back
      // down, so the next dial waits the FIRST rung rather than the ceiling.
      const spacingMs = stableConnectionMs + BACKOFF_BASE_MS;
      expect(
        fleetIdentifiesPerDay(dialers, spacingMs),
        `${dialers} instance(s) forgiven every ${stableConnectionMs}ms re-IDENTIFY past the ` +
          "token's quota, and the ladder's ceiling never applies because the ladder was reset",
      ).toBeLessThan(IDENTIFY_QUOTA_PER_DAY);
    },
  );

  it('both figures are the ones the ladder scales, not a pair this file chose', () => {
    expect(dialBudgetFor(1)).toEqual({
      reconnectCapMs: RECONNECT_CAP_MS,
      stableConnectionMs: STABLE_CONNECTION_MS,
    });
    expect(dialBudgetFor(undefined), 'an omitted gateway_dialers is one dialer').toEqual(
      dialBudgetFor(1),
    );
  });
});
