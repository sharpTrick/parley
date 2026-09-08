import { xml } from '@xmpp/client';
import { MAX_ERROR_BODY } from '@sharptrick/parley-net-util';
import { FORBIDDEN_IN_RENDER, UNSAFE_TEXT } from '@sharptrick/parley-net-util/testing';
import { describe, expect, it } from 'vitest';
import {
  conditionOf,
  describeError,
  type El,
  JoinError,
  stanzaError,
} from '../src/stanzas.js';

/**
 * CLASS: text the SERVER wrote reaching a thrown Error and an operator's stderr. A MUC states its
 * refusal in `<error><text>`, and nothing about that text is ours: it is echoed into a `post`
 * rejection, into a join failure, and into the line that reports lost occupancy — one of which core
 * renders into model context. Unbounded and unflattened, it can forge line structure in a log, hide
 * a line behind a bidi override, or run to whatever length the server chose.
 *
 * Every path stanza text takes out of this module, crossed with the shared text corpus, so a fourth
 * path added later is graded by adding a row rather than by remembering this file exists.
 */
const errorStanza = (text: string, condition = 'forbidden'): El =>
  xml(
    'message',
    { type: 'error' },
    xml(
      'error',
      { type: 'auth' },
      xml(condition, { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }),
      xml('text', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }, text),
    ),
  ) as unknown as El;

const CARRIERS: Array<[string, (text: string) => string]> = [
  ['the condition + text summary', (text) => describeError(stanzaError(errorStanza(text)))],
  ['a post rejection', (text) => `post rejected by room (${describeError(stanzaError(errorStanza(text)))})`],
  [
    'a join failure',
    (text) => {
      const { condition, text: detail } = stanzaError(errorStanza(text));
      return new JoinError('room', condition, detail).message;
    },
  ],
  [
    'the condition an error is branched on',
    (text) => conditionOf(new JoinError('room', stanzaError(errorStanza(text)).condition, '')),
  ],
];

describe('server-supplied stanza text reaches nothing as one unbounded line', () => {
  for (const [where, carry] of CARRIERS) {
    it.each(UNSAFE_TEXT)(`${where} strips %s`, (_label, text) => {
      const line = carry(text);
      expect(line).not.toMatch(FORBIDDEN_IN_RENDER);
      expect(line).not.toMatch(/[\n\r]/);
      expect(line.length).toBeLessThan(MAX_ERROR_BODY + 256);
    });
  }

  it('still carries the words the server wrote, so the rows above are not asserting silence', () => {
    expect(describeError(stanzaError(errorStanza('you are banned')))).toContain('you are banned');
    expect(describeError(stanzaError(errorStanza('x', 'forbidden')))).toContain('forbidden');
  });

  it('bounds a hostile CONDITION too, which is an element name the server chose', () => {
    const condition = 'x'.repeat(8192);
    const { condition: seen } = stanzaError(errorStanza('why', condition));
    expect(seen.length).toBeLessThanOrEqual(MAX_ERROR_BODY + 16);
  });
});
