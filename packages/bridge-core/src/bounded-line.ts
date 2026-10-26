/** Longest caller-authored fragment worth naming in a diagnostic; a name past this identifies nothing. */
export const MAX_NAMED_FRAGMENT = 128;

/**
 * One bounded line of CALLER-AUTHORED text, for a diagnostic that names it.
 *
 * A config key, a map entry's key, a topic and a room alias are all written by whoever wrote the
 * YAML, and every refusal that names one reaches an operator's log and the model context core
 * renders a seam error into. So a named fragment may not forge line structure, may not carry a bidi
 * override, and may not run unbounded. Lives in core because the obligation is the SEAM's: a plugin
 * cannot reach a backend-support package's sanitiser, and three of them had begun restating it.
 */
export function boundedLine(text: string, max: number = MAX_NAMED_FRAGMENT): string {
  const flat = text.replaceAll(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '\uFFFD');
  return flat.length <= max ? flat : `${flat.slice(0, max)}[truncated]`;
}
