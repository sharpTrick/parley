import { describe, expect, it } from 'vitest';
import { derivationFaults, derivedRows, rowText } from '@sharptrick/parley-net-util/testing';

/**
 * The ruler for every `it.each` table in the repository, graded on the two shapes it exists to
 * catch: a table that came back EMPTY, and a table that stayed large while losing the member the
 * scan was written to reach. The second is the one eighty-four hand-written floors let through.
 */
describe('a derived table is judged on its floor and its witnesses', () => {
  const ROWS = [['alpha', 1], ['beta', 2], ['gamma', 3]] as const;

  it.each([
    ['an empty table', [] as unknown[], 1, ['alpha'], 2],
    ['a table under its floor', ROWS, 10, ['alpha'], 1],
    ['a table that lost a witness', ROWS, 1, ['delta'], 1],
    ['a table that lost two witnesses', ROWS, 1, ['delta', 'epsilon'], 2],
    ['a table that holds everything claimed', ROWS, 3, ['alpha', 'gamma'], 0],
  ])('%s reports %#', (_label, rows, floor, witness, faults) => {
    expect(
      derivationFaults('table', rows as readonly unknown[], {
        floor,
        witness: witness as [string, ...string[]],
      }),
    ).toHaveLength(faults);
  });

  it.each([
    ['a string row', 'alpha', 'alpha'],
    ['a tuple row', ['alpha', 2], 'alpha 2'],
    ['a nested tuple row', [['alpha'], 'beta'], 'alpha beta'],
    ['an object row', { name: 'alpha', size: 2, make: () => 1 }, 'alpha 2'],
  ])('reads %s for its witnesses', (_label, row, text) => {
    expect(rowText(row)).toBe(text);
  });

  const handed = derivedRows('probe', () => ROWS, { floor: 1, witness: ['alpha'] });

  it('hands back the rows it graded, and registers a case of its own beside them', () => {
    expect(handed).toHaveLength(3);
  });
});
