import { expect, it } from 'vitest';

/**
 * CLASS: a derivation whose universe silently narrowed. `it.each([])` registers ZERO cases and the
 * file reports success, and the CI skip gate cannot see it either — it scores the groups it finds in
 * the run's assertion results, and a group that produced no rows has no key there. A whole describe
 * can evaporate with both green.
 *
 * A floor alone does not close it. Eighty-four hand-written floor rows were already in place and the
 * defects that shipped past them were narrowings of a table that stayed comfortably non-empty. The
 * WITNESS is the half that works: a member the table must contain, so a scan that stopped reading
 * half the tree fails on the member it stopped reaching rather than on a count.
 */

export interface Derivation {
  /** How many rows the table must hold before it can be believed at all. */
  floor: number;
  /**
   * Members the table must contain, each matched against ONE row's own text. Typed non-empty, so
   * that the half of this rule that works cannot be omitted.
   */
  witness: readonly [string, ...string[]];
  /**
   * A SECOND, independent count of the same universe — a different walk, or the same tree read
   * another way. Keep it independent of `produce`, so that a scan losing a subtree moves the two
   * sides apart: a floor only ever proves a table is non-empty, and a table narrowed from 573 rows
   * to 100 sat on its shipped floor of 100 with its shipped witnesses intact while 476 cases
   * evaporated green.
   */
  size?: () => number;
}

/** A row as text, for witness matching: every scalar it holds, however deeply nested. */
export function rowText(row: unknown, depth = 0): string {
  if (typeof row === 'string') return row;
  if (typeof row === 'function' || depth > 8) return '';
  if (Array.isArray(row)) return row.map((cell) => rowText(cell, depth + 1)).join(' ');
  if (row instanceof RegExp || row instanceof Date) return String(row);
  if (row !== null && typeof row === 'object')
    return Object.values(row as Record<string, unknown>)
      .map((value) => rowText(value, depth + 1))
      .filter((text) => text !== '')
      .join(' ');
  return String(row);
}

/** Everything wrong with a derived table, as reportable lines. Empty means the table is believable. */
export function derivationFaults(
  label: string,
  rows: readonly unknown[],
  { floor, witness, size }: Derivation,
): string[] {
  const faults: string[] = [];
  if (floor < 1)
    faults.push(
      `${label} declares a floor of ${floor}, which admits a table that came back empty — the ` +
        'floor is what makes an absent universe visible at all',
    );
  if (rows.length < floor)
    faults.push(
      `${label} derived ${rows.length} rows, below its floor of ${floor} — the scan that builds ` +
        'this table is reading less than it was written to read',
    );
  const texts = rows.map((row) => rowText(row));
  for (const name of witness) {
    if (name.trim() === '') {
      faults.push(
        `${label} declares an empty witness, which every table on earth satisfies — name a member ` +
          'the scan must actually reach',
      );
      continue;
    }
    // Per ROW, so that a witness cannot be satisfied by text spanning two of them.
    if (!texts.some((text) => text.includes(name)))
      faults.push(`${label} no longer holds \`${name}\`, a member it is written to cover`);
  }
  const universe = size?.();
  if (universe !== undefined && rows.length < universe)
    faults.push(
      `${label} derived ${rows.length} rows out of ${universe} counted independently — the table ` +
        'narrowed while staying above its floor, which is how 476 cases once vanished green',
    );
  return faults;
}

/**
 * The sanctioned way to build an `it.each` table out of the tree. Registers a case of its own, so an
 * empty or narrowed table fails as an ASSERTION rather than as an absence nothing reports.
 */
export function derivedRows<Row>(
  label: string,
  produce: () => readonly Row[],
  derivation: Derivation,
): Row[] {
  let rows: Row[] = [];
  let broke: unknown;
  try {
    rows = [...produce()];
  } catch (err) {
    broke = err;
  }
  it(`${label}: derived from the tree, not empty, and still holding its witnesses`, () => {
    if (broke !== undefined) throw broke;
    expect(derivationFaults(label, rows, derivation)).toEqual([]);
  });
  return rows;
}
