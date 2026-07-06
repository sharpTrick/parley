import { describe, expect, it } from 'vitest';
import { escapeHtml } from './html.js';

// CX-04: exactly one escapeHtml for the auth layer's consent browser flow. This locks its contract
// so the two render sites (consent page + 403 error page) can never silently diverge again.
describe('escapeHtml (single auth-layer HTML escaper — CX-04)', () => {
  it('maps the five HTML-significant characters to their entities', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes & FIRST so an inserted entity is never double-escaped', () => {
    // If `<` were replaced before `&`, the `&` in the inserted `&lt;` would be re-escaped to
    // `&amp;lt;`. A bare `<` mapping to exactly `&lt;` proves the ordering is correct.
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    // A literal that already looks like an entity is escaped exactly once, at its own `&`.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('claude-agent 42')).toBe('claude-agent 42');
  });
});
