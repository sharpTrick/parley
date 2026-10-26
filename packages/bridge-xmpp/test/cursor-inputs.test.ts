import { asCursor, asHandle, type Cursor } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { BASE, canAuth, freshTopic } from './live-xmpp.js';

// Class: the plugin's ASSUMPTION about how a server answers an out-of-range/unknown RSM `<after>`
// going untested. XEP-0313 says item-not-found; Prosody's mod_mam ignores the unknown UID and
// replays the archive from the start, so an expired cursor (mod_mam prunes at archive_expires_after,
// default 1w) degrades exclusive-since into a full re-read. Whatever the server does, the seam
// contract must hold: the call either resolves with messages or rejects with a real error, and the
// `nextCursor` it hands back must be replayable — feeding it straight back returns nothing new.

const cursorRows: Array<{ name: string; cursor: () => Cursor }> = [
  { name: 'the zero cursor (empty archive / first run)', cursor: () => asCursor('') },
  { name: 'a syntactically valid id the archive does not hold', cursor: () => asCursor('deadbeef-not-in-archive') },
  { name: 'a very long garbage string', cursor: () => asCursor('x'.repeat(4096)) },
  { name: 'a string with RSM/XML metacharacters', cursor: () => asCursor('<after>&amp;\'"/../') },
];

const serverUp = await canAuth(BASE);

describe.skipIf(!serverUp)('XMPP catch-up cursor inputs', () => {
  it.each(cursorRows)('$name resolves or throws, and its nextCursor is replayable', async ({ cursor }) => {
    const plugin = new XmppPlugin();
    await plugin.connect(BASE);
    const topic = freshTopic('cur');
    try {
      await plugin.post(topic, asHandle('a'), 'one');
      await plugin.post(topic, asHandle('a'), 'two');

      const first = await plugin.fetchRecent({ topic, since: cursor(), limit: 10 });
      // Whatever the server returned, replaying the cursor it handed back must not repeat it.
      const replay = await plugin.fetchRecent({ topic, since: first.nextCursor, limit: 10 });
      expect(replay.messages).toEqual([]);
      expect(String(replay.nextCursor)).toBe(String(first.nextCursor));
    } finally {
      await plugin.disconnect();
    }
  });

  it('a cursor minted in ANOTHER room does not leak that room history into this topic', async () => {
    const plugin = new XmppPlugin();
    await plugin.connect(BASE);
    const other = freshTopic('cur-other');
    const topic = freshTopic('cur-self');
    try {
      await plugin.post(other, asHandle('a'), 'other-room-secret');
      const otherTail = (await plugin.fetchRecent({ topic: other, limit: 10 })).nextCursor;
      await plugin.post(topic, asHandle('a'), 'mine');

      const res = await plugin.fetchRecent({ topic, since: otherTail, limit: 10 });
      expect(res.messages.map((m) => m.content)).not.toContain('other-room-secret');
      for (const m of res.messages) expect(String(m.topic)).toBe(String(topic));
    } finally {
      await plugin.disconnect();
    }
  });

  it('an exact tail cursor is exclusive: nothing older is replayed', async () => {
    const plugin = new XmppPlugin();
    await plugin.connect(BASE);
    const topic = freshTopic('cur-tail');
    try {
      await plugin.post(topic, asHandle('a'), 'one');
      const tail = (await plugin.fetchRecent({ topic, limit: 10 })).nextCursor;
      await plugin.post(topic, asHandle('a'), 'two');

      const res = await plugin.fetchRecent({ topic, since: tail, limit: 10 });
      expect(res.messages.map((m) => m.content)).toEqual(['two']);
    } finally {
      await plugin.disconnect();
    }
  });
});
