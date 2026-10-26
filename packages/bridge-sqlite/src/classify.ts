/**
 * How a DB error affects a retry. `lock` is the sanctioned silent-retry case (WAL + busy_timeout
 * resolve it). `unavailable` covers everything that can heal on its own — I/O errors, a read-only
 * or full volume, a file that is briefly unopenable while a backup swaps it — so a background loop
 * must keep probing. `fatal` is reserved for damage no amount of retrying repairs.
 */
export type DbErrorClass = 'lock' | 'unavailable' | 'fatal';

/**
 * Classify a DB error for the retry paths. Only damage that retrying cannot repair is `fatal`; an
 * unrecognised error is `unavailable`, so a class nobody anticipated backs off and self-heals
 * rather than permanently killing live push.
 */
export function classifyDbError(e: unknown): DbErrorClass {
  const code = (e as { code?: string } | null)?.code ?? '';
  const msg = errMessage(e);
  if (/BUSY|LOCKED/.test(code) || /database is locked|database table is locked/i.test(msg)) {
    return 'lock';
  }
  if (/CORRUPT|NOTADB/.test(code) || /malformed|file is not a database|no such table/i.test(msg)) {
    return 'fatal';
  }
  return 'unavailable';
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
