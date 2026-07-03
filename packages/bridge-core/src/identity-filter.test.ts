import { describe, expect, it } from 'vitest';
import { asHandle } from './message.js';
import { filterHandles, matchGlob } from './identity-filter.js';

describe('matchGlob', () => {
  it('matches a prefix wildcard', () => {
    expect(matchGlob('claude-*', 'claude-payments')).toBe(true);
    expect(matchGlob('claude-*', 'claude-')).toBe(true);
    expect(matchGlob('claude-*', 'human-x')).toBe(false);
  });

  it('matches a suffix wildcard and a single-char ?', () => {
    expect(matchGlob('*-bot', 'chat-bot')).toBe(true);
    expect(matchGlob('*-bot', 'chat-boat')).toBe(false);
    expect(matchGlob('claude-?', 'claude-a')).toBe(true);
    expect(matchGlob('claude-?', 'claude-ab')).toBe(false);
  });

  it('anchors fully and treats other regex metachars as literals', () => {
    expect(matchGlob('ctx', 'ctx-payments')).toBe(false); // no implicit substring
    expect(matchGlob('a.b', 'a.b')).toBe(true);
    expect(matchGlob('a.b', 'axb')).toBe(false); // '.' is literal, not "any char"
    expect(matchGlob('a+b', 'a+b')).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(matchGlob('Claude-*', 'claude-a')).toBe(false);
  });
});

describe('filterHandles', () => {
  const items = [
    { handle: asHandle('claude-a') },
    { handle: asHandle('claude-b') },
    { handle: asHandle('human-x') },
  ];

  it('returns all when filter is undefined', () => {
    expect(filterHandles(items)).toHaveLength(3);
  });

  it('applies the glob', () => {
    expect(filterHandles(items, 'claude-*').map((i) => i.handle)).toEqual(['claude-a', 'claude-b']);
  });
});
