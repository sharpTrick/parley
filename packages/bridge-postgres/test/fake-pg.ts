/**
 * PostgreSQL's answer to the one SELECT shape this plugin's push and catch-up paths depend on:
 * `WHERE topic = $1 AND seq > $2 ORDER BY <table>.seq {ASC|DESC} LIMIT n`.
 *
 * A fake that hands rows back from a queue honours the cursor predicate and the ordering for free,
 * so the drain loop's ascending-and-exactly-once guarantee is asserted against a mock that supplies
 * it rather than against the query that has to earn it. These serve the predicate, the direction
 * and the limit from the SQL text, so flipping the ORDER BY or dropping the `seq > $2` filter in
 * the plugin changes what the fake returns exactly as the server would.
 */

export type FakeRow = Record<string, unknown>;

const WINDOW = /seq > \$2/;
const LITERAL_LIMIT = /LIMIT (\d+)/;
const DIRECTION = /ORDER BY\s+"?\w+"?\.seq\s+(ASC|DESC)/i;

export function isWindowSelect(sql: string): boolean {
  return WINDOW.test(sql);
}

export function isMaxSeq(sql: string): boolean {
  return /MAX\(seq\)/.test(sql);
}

export function maxSeq(all: readonly FakeRow[]): string {
  return String(all.reduce((m, r) => Math.max(m, Number(r['seq'])), 0));
}

export function serveWindow(all: readonly FakeRow[], sql: string, values: readonly unknown[]): FakeRow[] {
  const since = Number(values[1] ?? 0);
  const descending = DIRECTION.exec(sql)?.[1]?.toUpperCase() === 'DESC';
  const literal = LITERAL_LIMIT.exec(sql);
  const limit = literal !== null ? Number(literal[1]) : Number(values[2] ?? 100);
  return all
    .filter((r) => Number(r['seq']) > since)
    .sort((a, b) => (descending ? -1 : 1) * (Number(a['seq']) - Number(b['seq'])))
    .slice(0, limit);
}

/** Serve whichever of the two shapes the SQL is, or `undefined` for anything else. */
export function servePool(
  all: readonly FakeRow[],
  sql: string,
  values: readonly unknown[],
): FakeRow[] | undefined {
  if (isMaxSeq(sql)) return [{ max: maxSeq(all) }];
  if (isWindowSelect(sql)) return serveWindow(all, sql, values);
  return undefined;
}
