import { describe, expect, it } from 'vitest';
import { isMentionableHandle, parseMentions } from './mentions.js';
import { asHandle } from './message.js';
import { HANDLE_CANDIDATES } from './testing/handle-corpus.js';

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

  it('parsed handle satisfies the mention-filter predicate (end to end)', () => {
    // This is the exact predicate push-loop.ts evaluates for `mention_filter: true`.
    expect(parseMentions('ping @bob.').includes(asHandle('bob'))).toBe(true);
  });
});

// The accepted charset is a DELIVERY boundary: `live_push.mention_filter` drops every inbound
// message whose parsed mentions do not contain the configured handle, so narrowing the grammar
// silently discards traffic and widening it surfaces traffic nobody addressed. Every other test in
// this file derives its expectation from the same regex the module compiles, so all of them survive
// an edit that moves producer and predicate together. These rows do not: each expected value is
// written out, so the charset cannot move without reddening one.
const GRAMMAR: readonly (readonly [label: string, content: string, expected: readonly string[]])[] =
  [
    ['interior underscore is part of the handle', 'hi @a_b there', ['a_b']],
    ['interior dot is part of the handle', 'hi @a.b there', ['a.b']],
    ['interior hyphen is part of the handle', 'hi @a-b there', ['a-b']],
    ['interior digit is part of the handle', 'hi @a0b there', ['a0b']],
    ['interior uppercase is part of the handle', 'hi @aBb there', ['aBb']],
    ['repeated interior punctuation is part of the handle', 'hi @a..b there', ['a..b']],
    ['interior colon ends the handle', 'hi @a:b there', ['a']],
    ['interior slash ends the handle', 'hi @a/b there', ['a']],
    ['interior plus ends the handle', 'hi @a+b there', ['a']],
    ['interior at-sign ends the handle', 'hi @a@b there', ['a']],
    ['interior space ends the handle', 'hi @a b there', ['a']],
    ['interior comma ends the handle', 'hi @a,b there', ['a']],
    ['interior hash ends the handle', 'hi @a#b there', ['a']],
    ['interior tilde ends the handle', 'hi @a~b there', ['a']],
    ['interior non-ASCII letter ends the handle', 'hi @aéb there', ['a']],
    ['leading underscore yields no handle', 'hi @_ab there', []],
    ['leading dot yields no handle', 'hi @.ab there', []],
    ['leading hyphen yields no handle', 'hi @-ab there', []],
    ['leading digit is part of the handle', 'hi @0ab there', ['0ab']],
    ['trailing underscore is dropped', 'hi @ab_ there', ['ab']],
    ['trailing dot is dropped', 'hi @ab. there', ['ab']],
    ['trailing hyphen is dropped', 'hi @ab- there', ['ab']],
    ['trailing digit is part of the handle', 'hi @ab0 there', ['ab0']],
    ['a single alphanumeric is a handle', 'hi @a there', ['a']],
    ['a single digit is a handle', 'hi @0 there', ['0']],
    ['a single underscore is not a handle', 'hi @_ there', []],
    ['lone punctuation is not a handle', 'hi @. and @- there', []],
  ];

// The other half of the grammar: what may sit immediately before the `@`. Widening this is how
// `config.@alice` and `build-@bob` start reading as mentions; narrowing it is how a mention after
// ordinary punctuation stops being delivered.
const GUARD: readonly (readonly [label: string, prefix: string, expected: readonly string[]])[] = [
  ['start of string admits the mention', '', ['bob']],
  ['a space admits the mention', 'ping ', ['bob']],
  ['an open paren admits the mention', 'ping (', ['bob']],
  ['an asterisk admits the mention', 'ping *', ['bob']],
  ['a comma admits the mention', 'ping,', ['bob']],
  ['a newline admits the mention', 'ping\n', ['bob']],
  ['a colon admits the mention', 'ping:', ['bob']],
  ['a slash admits the mention', 'ping/', ['bob']],
  ['a bang admits the mention', 'ping!', ['bob']],
  ['an alphanumeric suppresses the mention', 'alice', []],
  ['an underscore suppresses the mention', 'alice_', []],
  ['a dot suppresses the mention', 'alice.', []],
  ['a hyphen suppresses the mention', 'alice-', []],
  ['an at-sign suppresses the mention', 'alice@', []],
];

const ROWS: readonly (readonly [label: string, content: string, expected: readonly string[]])[] = [
  ...GRAMMAR,
  ...GUARD.map(([label, prefix, expected]) => [label, `${prefix}@bob`, expected] as const),
];

describe('the @mention grammar, pinned as literals', () => {
  it.each(ROWS)('%s', (_label, content, expected) => {
    expect(parseMentions(content)).toEqual(expected);
  });
});

// A table of literals only guards the grammar while its rows still DISCRIMINATE. Rebuild the two
// classes here as independent literals and re-derive the parse from them, so a one-character edit to
// either class can be replayed against the table: a mutant no row disagrees with is a hole in the
// table, and it fails HERE rather than after the hole has been shipped.
const HANDLE_BODY = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?';
const GUARD_CLASS = '[^A-Za-z0-9_.@-]';

const parseWith =
  (body: string, guard: string) =>
  (content: string): string[] => {
    const re = new RegExp(`(?:^|${guard})@(${body})`, 'g');
    return [...new Set([...content.matchAll(re)].map((m) => m[1] ?? ''))];
  };

const MUTANTS: readonly (readonly [label: string, body: string, guard: string])[] = [
  ['the interior class drops _', '[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', GUARD_CLASS],
  ['the interior class drops .', '[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?', GUARD_CLASS],
  ['the interior class drops -', '[A-Za-z0-9](?:[A-Za-z0-9._]*[A-Za-z0-9])?', GUARD_CLASS],
  ['the interior class gains :', '[A-Za-z0-9](?:[A-Za-z0-9.:_-]*[A-Za-z0-9])?', GUARD_CLASS],
  ['the interior class gains /', '[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?', GUARD_CLASS],
  [
    'the handle may start with punctuation',
    '[A-Za-z0-9._-](?:[A-Za-z0-9._-]*[A-Za-z0-9])?',
    GUARD_CLASS,
  ],
  ['the handle may end with punctuation', '[A-Za-z0-9][A-Za-z0-9._-]*', GUARD_CLASS],
  ['the guard class drops _', HANDLE_BODY, '[^A-Za-z0-9.@-]'],
  ['the guard class drops .', HANDLE_BODY, '[^A-Za-z0-9_@-]'],
  ['the guard class drops -', HANDLE_BODY, '[^A-Za-z0-9_.@]'],
  ['the guard class drops @', HANDLE_BODY, '[^A-Za-z0-9_.-]'],
];

describe('the pinned grammar table discriminates', () => {
  it('restates the shipped grammar exactly', () => {
    const restated = parseWith(HANDLE_BODY, GUARD_CLASS);
    for (const [label, content] of ROWS)
      expect(restated(content), label).toEqual(parseMentions(content));
  });

  it.each(MUTANTS)('a grammar where %s reddens at least one row', (_label, body, guard) => {
    const mutant = parseWith(body, guard);
    const caught = ROWS.filter(
      ([, content, expected]) => JSON.stringify(mutant(content)) !== JSON.stringify(expected),
    );
    expect(caught.map(([label]) => label).length).toBeGreaterThan(0);
  });
});

// The mention grammar and the handle grammar must be one grammar: `mention_filter` compares a
// configured handle against parsed mentions, so any handle isMentionableHandle admits has to be
// reachable from content, and any it rejects must be unreachable. Widening either side alone
// re-opens the silent-drop class, so assert the equivalence over a corpus, not fixed strings.
describe('isMentionableHandle agrees with parseMentions', () => {
  it.each(HANDLE_CANDIDATES.map((h) => [JSON.stringify(h), h] as const))(
    'round-trips exactly when it says it will (%s)',
    (_label, handle) => {
      const parsed = parseMentions(`hi @${handle} there`);
      expect(parsed.includes(asHandle(handle))).toBe(isMentionableHandle(handle));
    },
  );
});
