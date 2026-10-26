/**
 * The one HTML-escaper for the auth layer's consent browser flow (DESIGN §10/§14). Escapes the five
 * HTML-significant characters — `&` FIRST so an already-inserted entity is never double-escaped —
 * which covers both the text-content and the double-quoted attribute sites in ./consent-page.ts.
 * Module-private to the auth layer: NOT re-exported from the package barrel.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
