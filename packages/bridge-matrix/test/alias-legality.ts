/**
 * The one predicate for "a room alias this plugin may put on the wire", shared by the table that
 * grades names DERIVED from a topic and the table that grades names an OPERATOR supplied. Kept as
 * literals rather than imported from `src/alias.ts`, so that widening the charset or the byte bound
 * in the code cannot widen the tests that grade it in the same commit.
 */

/** Matrix's own alias grammar, as narrow as the fold `sanitizeAlias` can produce. */
export const ALIAS_LEGAL = /^#[A-Za-z0-9._-]+:[^:]+$/;

/** Bytes a room alias may occupy, `#` and `:<server_name>` included. */
export const MAX_ALIAS_BYTES = 255;

export const aliasIsLegal = (alias: string): boolean =>
  ALIAS_LEGAL.test(alias) && Buffer.byteLength(alias, 'utf8') <= MAX_ALIAS_BYTES;

/**
 * Localparts hostile to that grammar, one per way a name can break it. The colon row is the
 * dangerous one — Matrix splits an alias on its FIRST colon, so `#a:b:fake` names the server
 * `b:fake` rather than the `server_name` the config chose.
 */
export const HOSTILE_LOCALPARTS: Record<string, string> = {
  'a colon, which re-homes the alias on another server': 'a:b',
  'a leading hash': '#hash',
  'a slash': 'ok/slash',
  'a space': 'has space',
  'a NUL byte': 'nul\u0000byte',
  'an astral emoji': 'emoji\u{1F600}',
  'an at sign': '@at',
  'a run far past the byte budget': 'x'.repeat(400),
  'a run one byte past the budget': 'x'.repeat(MAX_ALIAS_BYTES - '#:fake'.length + 1),
};
