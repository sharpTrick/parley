import { describe, expect, it } from 'vitest';
import { parseMentions } from './mentions.js';
import { asHandle } from './message.js';

describe('parseMentions', () => {
  it('extracts @handles including hyphenated ones', () => {
    expect(parseMentions('hey @bob and @ctx-payments please review')).toEqual([
      'bob',
      'ctx-payments',
    ]);
  });

  it('dedupes and preserves first-seen order', () => {
    expect(parseMentions('@a @b @a @c @b')).toEqual(['a', 'b', 'c']);
  });

  it('matches a mention at the start of the string', () => {
    expect(parseMentions('@alice hi')).toEqual(['alice']);
  });

  it('does not treat an email address as a mention', () => {
    expect(parseMentions('mail me at alice@example.com')).toEqual([]);
  });

  it('returns empty for no mentions', () => {
    expect(parseMentions('just some text')).toEqual([]);
  });

  it('excludes trailing punctuation from the handle (BUG-21)', () => {
    expect(parseMentions('ping @bob.')).toEqual(['bob']);
    expect(parseMentions('@bob-')).toEqual(['bob']);
    expect(parseMentions('@bob_')).toEqual(['bob']);
    expect(parseMentions('reply to @bob. thanks')).toEqual(['bob']);
  });

  it('preserves interior punctuation and single-char handles', () => {
    expect(parseMentions('cc @a.b and @ctx-payments')).toEqual(['a.b', 'ctx-payments']);
    expect(parseMentions('@a')).toEqual(['a']);
  });

  it('does not produce a handle from lone punctuation', () => {
    expect(parseMentions('@.')).toEqual([]);
    expect(parseMentions('@-')).toEqual([]);
  });

  it('parsed handle satisfies the mention-filter predicate (BUG-21 end-to-end)', () => {
    // This is the exact predicate push-loop.ts evaluates for `mention_filter: true`.
    expect(parseMentions('ping @bob.').includes(asHandle('bob'))).toBe(true);
  });
});
