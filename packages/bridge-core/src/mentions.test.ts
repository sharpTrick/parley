import { describe, expect, it } from 'vitest';
import { parseMentions } from './mentions.js';

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
});
