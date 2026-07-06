/**
 * The one HTML-escaper for the auth layer's consent browser flow (DESIGN §10/§14). Escapes the five
 * HTML-significant characters — `&` FIRST so an already-inserted entity is never double-escaped —
 * which covers both the text-content site (the 403 consent-error page in ./remote.ts) and the
 * double-quoted attribute site (the consent page in ./oauth-provider.ts). Module-private to the auth
 * layer: NOT re-exported from the package barrel.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
