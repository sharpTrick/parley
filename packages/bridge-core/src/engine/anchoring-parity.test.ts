import { describe, expect, it } from 'vitest';
import { Allowlist } from '../allowlist.js';
import { asHandle } from '../message.js';
import { ANCHORING_CASES } from '../testing/anchoring-corpus.js';
import { filterReachable, type RosterEntry } from './presence.js';

/**
 * One security-shaped rule — a source core did not author is compiled FULL-MATCH anchored — with two
 * independent implementations. The `post_topics` half was pinned; the `filterReachable` half, the one
 * whose sources come from an untrusted peer's presence beat, was not: dropping its `^(?:…)$` left the
 * entire suite green while a peer advertising `ops` became "can post into my-ops-secret".
 *
 * So grade both call sites off one corpus and require IDENTICAL verdicts. Registering a third site
 * here is then the visible cost of adding one, which is the point.
 */
describe('every site that compiles an untrusted pattern anchors it the same way', () => {
  const peer = (postTopics: string[]): RosterEntry => ({
    handle: asHandle('stranger'),
    online: true,
    topics: [], // no explicitly shared topic: the PATTERN is the only thing that can reach me
    postTopics,
    lastSeenMs: 0,
  });

  const SITES: readonly (readonly [label: string, matches: (source: string, input: string) => boolean])[] = [
    ['Allowlist.has (my own post_topics)', (source, input) => new Allowlist([], { postPatterns: [source] }).has(input)],
    [
      'filterReachable (a peer\'s advertised postTopics)',
      (source, input) =>
        filterReachable([peer([source])], {
          canPostTo: () => false,
          mySubscribedTopics: [input],
        }).length === 1,
    ],
    [
      'filterReachable, scoped to one topic',
      (source, input) =>
        filterReachable([peer([source])], {
          scope: input,
          canPostTo: () => false,
          mySubscribedTopics: [],
        }).length === 1,
    ],
  ] as const;

  // Pin membership by value: a generated table cannot see a row deleted from the list generating it,
  // and the substring rows below are exactly the ones an unanchored compile would let through.
  it('pins the corpus membership', () => {
    expect(ANCHORING_CASES.length).toBe(12);
    expect(ANCHORING_CASES.filter(([, , , full]) => !full).length).toBe(7);
  });

  it.each(
    SITES.flatMap(([site, matches]) =>
      ANCHORING_CASES.map(
        ([label, source, input, fullMatch]) =>
          [`${site} × ${label}`, matches, source, input, fullMatch] as const,
      ),
    ),
  )('%s', (_name, matches, source, input, fullMatch) => {
    expect(matches(source, input)).toBe(fullMatch);
  });
});
