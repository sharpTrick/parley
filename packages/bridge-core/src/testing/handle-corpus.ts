/**
 * The ONE corpus of handle strings every layer that decides whether a handle is *addressable* is
 * graded against: {@link parseMentions}/{@link isMentionableHandle}'s round trip, and `parseConfig`'s
 * `live_push.mention_filter` load-time check.
 *
 * Keep this list single, so that a character class one layer starts admitting is exercised at the
 * other too — the two layers disagreeing is precisely the silent-drop class (a configured handle no
 * message can ever produce drops every inbound message), and a candidate only one list carries is a
 * character the other layer stops grading the moment it is added here.
 */
export const HANDLE_CANDIDATES: readonly string[] = [
  'a',
  'bob',
  'Bob',
  'b0t',
  'ctx-payments',
  'a.b',
  'a_b',
  'a-b-c',
  'a..b',
  'x'.repeat(64),
  '_bot',
  '-bot',
  '.bot',
  'bot_',
  'bot-',
  'bot.',
  'bot bot',
  '@bot',
  'bot@example.com',
  'алиса',
  '',
  '.',
  '-',
  'a/b',
  'a:b',
];
