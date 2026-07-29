import { asCursor, asHandle, type Topic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { describe, expect, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { priv } from './fake-xmpp.js';
import { BASE, canAuth, freshTopic } from './live-xmpp.js';

// Class: history that exists only while the connection does. A MUC room and its whole MAM archive
// live only as long as the room has an occupant unless the room is PERSISTENT, and occupancy is
// presence on one stream — so any drop (a blip, a server restart, a malformed stanza from any
// client on the account) empties every non-persistent room this bridge serves and takes the
// catch-up history of every topic with it, cursors included. Catch-up is the whole seam here, so
// this is exercised against a real server: post, drop the stream underneath the plugin, wait for
// the re-join, and demand the pre-drop history is still there — for a subscribed topic and for a
// catch-up-only one, since they enter the join cache by different paths.

const up = await canAuth(BASE);

const drop = async (plugin: XmppPlugin): Promise<void> => {
  const conn = priv(plugin).xmpp as { send(el: unknown): Promise<unknown> };
  // A codepoint XML forbids, put on the wire BENEATH post()'s validation: this is exactly what an
  // unguarded payload did, and the most faithful way to make the server abort the stream.
  await conn
    .send(xml('message', { to: 'nowhere@example.invalid' }, xml('body', {}, `x${String.fromCharCode(1)}`)))
    .catch(() => undefined);
};

const waitFor = async (probe: () => Promise<boolean>, budgetMs = 20_000): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

describe.skipIf(!up)('XMPP history survives a stream drop (live server)', () => {
  it.each([
    { how: 'subscribed', subscribe: true },
    { how: 'catch-up only', subscribe: false },
  ])('a topic entered $how keeps its archive across a reconnect', async ({ subscribe }) => {
    const plugin = new XmppPlugin();
    await plugin.connect(BASE as Record<string, unknown>);
    const topic: Topic = freshTopic('drop');
    const bystander: Topic = freshTopic('by');
    try {
      if (subscribe) await plugin.subscribe(topic, () => undefined);
      await plugin.post(topic, asHandle('a'), 'before-the-drop');
      await plugin.post(bystander, asHandle('a'), 'unrelated-history');

      await drop(plugin);
      // Let @xmpp/reconnect re-establish before probing, so that the first query is not spent
      // waiting out its IQ timeout on a stream that is already gone.
      await new Promise((r) => setTimeout(r, 3_000));

      const recovered = await waitFor(async () => {
        const back = await plugin.fetchRecent({ topic, since: asCursor('') });
        return back.messages.length > 0;
      });
      expect(recovered).toBe(true);

      const back = await plugin.fetchRecent({ topic, since: asCursor('') });
      expect(back.messages.map((m) => m.content)).toEqual(['before-the-drop']);
      // The drop was one stanza on one topic; every OTHER topic must be untouched by it.
      const other = await plugin.fetchRecent({ topic: bystander, since: asCursor('') });
      expect(other.messages.map((m) => m.content)).toEqual(['unrelated-history']);

      // Occupancy is back, not just the archive: a post is reflected again.
      await plugin.post(topic, asHandle('a'), 'after-the-drop');
      const both = await plugin.fetchRecent({ topic, since: asCursor('') });
      expect(both.messages.map((m) => m.content)).toEqual(['before-the-drop', 'after-the-drop']);
    } finally {
      await plugin.disconnect();
    }
  }, 60_000);
});
