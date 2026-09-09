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
    // A floor of zero admits the one shape this rule exists to catch, so it is a fault ABOUT the
    // derivation rather than a lenient setting: `[]` satisfies it and registers nothing.
    ['a floor that admits an empty table', ROWS, 0, ['alpha'], 1],
    ['an empty witness, which every table satisfies', ROWS, 1, [''], 1],
    ['a whitespace witness', ROWS, 1, ['  '], 1],
    // The witness is matched against ONE row. Concatenating the rows and searching the blob let
    // `'alpha 2 beta'` — text that exists in no row — count as a member the scan still reaches.
    ['a witness that only spans two rows', ROWS, 1, ['1\nbeta'], 1],
    // Within ONE row too: a row's cells are matched one at a time, so a phrase that exists only
    // where two of them meet names no member.
    ['a witness that only spans two cells of one row', ROWS, 1, ['alpha 1'], 1],
    // A witness shorter than a symbol or a path is matched as a WHOLE cell. `['1','2','3','5','6']`
    // was live over a numeric table, and every one of them was satisfied by substring against rows
    // the witness does not name.
    ['a short witness that names a row', [1, 2, 3, 5, 6], 1, ['1', '5'], 0],
    ['a short witness matched only inside a longer row', [12, 13, 15, 16, 1234, 99], 1, ['1'], 1],
    ['five short witnesses against six impostor rows', [12, 13, 15, 16, 1234, 99], 5, ['1', '2', '3', '5', '6'], 5],
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
    // An object row used to be read as its SCALAR values only, so a witness naming a file the row
    // carries in an array could never match and the only nameable member was the label the author
    // had already written by hand.
    ['an object row carrying an array', { name: 'alpha', files: ['x.ts', 'y.ts'] }, 'alpha x.ts y.ts'],
    ['an object row carrying an object', { name: 'alpha', at: { file: 'x.ts' } }, 'alpha x.ts'],
  ])('reads %s for its witnesses', (_label, row, text) => {
    expect(rowText(row)).toBe(text);
  });

  /**
   * The shape a floor and a witness set together cannot see: a table that keeps both while losing
   * most of its universe. Narrowing the 573-row repo-wide scan in source-hygiene to 100 rows, with
   * its SHIPPED floor of 100 and its SHIPPED witnesses untouched, took the suite from 718 cases to
   * 242 — 476 evaporated green. The declared floors against their real universes were 100/573,
   * 11/15, 5/10, 5/9 and 5/9, so between 45% and 82% of every one of them could vanish.
   */
  it.each([
    ['the xmpp comment scan', 9, 5],
    ['the package-boundary scan', 15, 11],
    ['the repo-wide source scan', 573, 100],
  ])('%s narrowed to its floor is a fault, not a pass', (_label, trueSize, floor) => {
    const universe = Array.from({ length: trueSize }, (_, at) => `member-${at}`);
    const witness: [string, ...string[]] = ['member-0', 'member-1'];
    expect(derivationFaults('table', universe, { floor, witness, size: () => trueSize })).toEqual([]);
    for (const kept of [floor, trueSize - 1]) {
      expect(
        derivationFaults('table', universe.slice(0, kept), { floor, witness, size: () => trueSize }),
        `${kept} of ${trueSize} rows, above the floor and still holding both witnesses`,
      ).not.toEqual([]);
    }
  });

  const handed = derivedRows('probe', () => ROWS, { floor: 1, witness: ['alpha'] });

  it('hands back the rows it graded, and registers a case of its own beside them', () => {
    expect(handed).toHaveLength(3);
  });
});
