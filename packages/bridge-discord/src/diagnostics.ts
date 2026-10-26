import { sanitizeBody } from '@sharptrick/parley-net-util';

/**
 * Every operator-facing diagnostic, on ONE line. Keep the scrub delegated to net-util's shared
 * neutralizer rather than a local character class, so that a family nobody listed — NEL, CSI, an
 * ESC that rewrites the line above — cannot forge an entry in the operator's log.
 */
export function warn(line: string): void {
  process.stderr.write(`parley-discord: ${sanitizeBody(line)}\n`);
}

/** The text of a caught rejection, for a diagnostic that must never crash on a non-Error. */
export const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** How a refused payload is named in a diagnostic, without quoting the payload itself. */
export const shapeOf = (d: unknown): string => (d === null ? 'null' : `a ${typeof d}`);
