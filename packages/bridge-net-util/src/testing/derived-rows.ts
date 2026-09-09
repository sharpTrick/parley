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
   * Members the table must contain, matched as substrings of each row's own text. Typed non-empty,
   * so that the half of this rule that works cannot be omitted.
   */
  witness: readonly [string, ...string[]];
}

/** A row as text, for witness matching: the tuple's members, an object's scalar values, or itself. */
export function rowText(row: unknown): string {
  if (typeof row === 'string') return row;
  if (Array.isArray(row)) return row.map(rowText).join(' ');
  if (row !== null && typeof row === 'object')
    return Object.values(row as Record<string, unknown>)
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .join(' ');
  return String(row);
}

/** Everything wrong with a derived table, as reportable lines. Empty means the table is believable. */
export function derivationFaults(
  label: string,
  rows: readonly unknown[],
  { floor, witness }: Derivation,
): string[] {
  const faults: string[] = [];
  if (rows.length < floor)
    faults.push(
      `${label} derived ${rows.length} rows, below its floor of ${floor} — the scan that builds ` +
        'this table is reading less than it was written to read',
    );
  const text = rows.map(rowText).join('\n');
  for (const name of witness)
    if (!text.includes(name))
      faults.push(`${label} no longer holds \`${name}\`, a member it is written to cover`);
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
