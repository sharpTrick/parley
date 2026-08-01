import { describe, expect, it } from 'vitest';
import { MAX_ERROR_BODY, sanitizeBody } from '@sharptrick/parley-net-util';
describe('sanitizeBody', () => {
  // Anything that can forge line structure, reorder text, or hide itself. Generated per FAMILY, not
  // per remembered character: the listed version covered C0 and the bidi controls but not C1, so
  // U+0085 NEL (a line terminator in most terminals) and U+009B CSI (the 8-bit ANSI introducer)
  // passed straight through a guard documented as flattening the body.
  const span = (from: number, to: number): string =>
    Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i)).join('');

  const FORBIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
  const HALF_A_PAIR = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  const FAMILIES: [string, string][] = [
    ['the whole C0 range', span(0x00, 0x1f)],
    ['DEL', '\u007F'],
    ['the whole C1 range', span(0x80, 0x9f)],
    ['line and paragraph separators', '\u2028\u2029'],
    ['bidi marks, embeddings and overrides', span(0x200e, 0x200f) + span(0x202a, 0x202e)],
    ['bidi isolates', span(0x2066, 0x2069)],
    ['zero-width joiners, soft hyphen and BOM', '\u200C\u200D\u00AD\uFEFF'],
    ['interlinear annotation controls', span(0xfff9, 0xfffb)],
    ['a lone high surrogate', '\uD800'],
    ['a lone low surrogate', '\uDFFF'],
  ];

  it.each(FAMILIES)('strips %s so the body cannot forge structure or hide', (_label, chars) => {
    const payload = `head${chars}tail`;
    const out = sanitizeBody(payload);
    expect(FORBIDDEN.test(out)).toBe(false);
    expect(HALF_A_PAIR.test(out)).toBe(false);
    expect(out.length).toBeLessThanOrEqual(payload.length);
    expect(out).toContain('head');
    expect(out).toContain('tail');
  });

  it('keeps the printable text a family was hiding among', () => {
    expect(sanitizeBody('a\u0085b\u009Bc')).toBe('a b c');
  });

  it('truncates past the cap and marks it', () => {
    const out = sanitizeBody('x'.repeat(MAX_ERROR_BODY + 50));
    expect(out.length).toBeLessThanOrEqual(MAX_ERROR_BODY + 20);
    expect(out).toMatch(/truncated/);
  });

  // Slicing at a UTF-16 boundary can land between the halves of an astral character, and half a
  // pair reaches the MCP result as something nothing downstream can decode.
  it.each([0, 1, 2])('never emits half an astral character at the cap (offset %i)', (offset) => {
    const out = sanitizeBody(`${'x'.repeat(MAX_ERROR_BODY - 1 + offset)}\u{1F600}${'y'.repeat(80)}`);
    expect(HALF_A_PAIR.test(out)).toBe(false);
    expect(out.length).toBeLessThanOrEqual(MAX_ERROR_BODY + 20);
  });

  it('leaves an ordinary short body intact', () => {
    expect(sanitizeBody('channel_not_found')).toBe('channel_not_found');
  });
});
