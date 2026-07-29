import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { attach, FakeXmpp, illegalCodepoint } from './fake-xmpp.js';

// Class: caller content serialised onto a shared, stateful transport without being validated for
// what that transport can carry. XMPP is one long-lived XML stream: a single codepoint XML forbids
// is not a rejected message, it is `not-well-formed` and the END of the stream — which drops MUC
// occupancy for EVERY room this connection serves and destroys each non-persistent room's whole
// MAM archive. So the blast radius of one bad byte in one topic is every OTHER topic's history.
// The table walks every codepoint XML 1.0 excludes, with legal-but-tricky payloads as negative
// controls, and demands of each that the post either round-trips or is refused with the offending
// codepoint named — and, in both cases, that an untouched second topic still has its history.

const HOSTILE = 'hostile';
const BYSTANDER = 'bystander';

interface Case {
  name: string;
  payload: string;
  legal: boolean;
}

const c0 = (cp: number): Case => ({
  name: `C0 control U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
  payload: `before${String.fromCharCode(cp)}after`,
  legal: false,
});

const cases: Case[] = [
  ...Array.from({ length: 0x20 }, (_, cp) => cp)
    .filter((cp) => cp !== 0x9 && cp !== 0xa && cp !== 0xd)
    .map(c0),
  { name: 'lone high surrogate', payload: 'x\uD800y', legal: false },
  { name: 'lone low surrogate', payload: 'x\uDC00y', legal: false },
  { name: 'noncharacter U+FFFE', payload: `x${String.fromCharCode(0xfffe)}y`, legal: false },
  { name: 'noncharacter U+FFFF', payload: `x${String.fromCharCode(0xffff)}y`, legal: false },
  { name: 'tab, newline and carriage return', payload: 'a\tb\nc\rd', legal: true },
  { name: 'astral emoji (a valid surrogate PAIR)', payload: 'ship it 🚀', legal: true },
  { name: 'markup metacharacters', payload: `<body>&amp;</body> "quoted" 'x' ]]>`, legal: true },
  { name: 'plain ascii', payload: 'ordinary', legal: true },
];

describe('XMPP post() cannot put a stream-killing codepoint on the wire', () => {
  it.each(cases)('$name', async ({ payload, legal }) => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    const p = attach(plugin, fake);
    const hostile = asTopic(HOSTILE);
    const bystander = asTopic(BYSTANDER);
    p.joined.set(p.roomJid(hostile), Promise.resolve());
    p.joined.set(p.roomJid(bystander), Promise.resolve());
    await plugin.post(bystander, asHandle('a'), 'unrelated-history');

    const outcome = await plugin.post(hostile, asHandle('a'), payload).then(
      () => 'resolved',
      (e: Error) => e.message,
    );

    if (legal) {
      expect(outcome).toBe('resolved');
      const back = await plugin.fetchRecent({ topic: hostile, since: asCursor('') });
      expect(back.messages.map((m) => m.content)).toEqual([payload]);
    } else {
      const cp = illegalCodepoint(payload) as number;
      expect(outcome).toContain(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }

    // The stream survived: an unrelated topic still has the history it had before the bad post.
    const other = await plugin.fetchRecent({ topic: bystander, since: asCursor('') });
    expect(other.messages.map((m) => m.content)).toEqual(['unrelated-history']);
    await plugin.disconnect();
  });

  it('refuses a nick that would abort the stream on the very first join presence', async () => {
    const plugin = new XmppPlugin();
    await expect(
      plugin.connect({ nick: `parley${String.fromCharCode(0)}`, password: 'a-real-secret' }),
    ).rejects.toThrow(/U\+0000/);
  });
});
