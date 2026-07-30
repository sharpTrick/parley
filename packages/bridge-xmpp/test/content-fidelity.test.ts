import { asHandle } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { BASE, canAuth, freshTopic } from './live-xmpp.js';

// Class: a content divergence the shared conformance suite deliberately does not grade, left as
// prose. XMPP bodies are XML character data and XML 1.0 §2.11 makes the PARSER fold a literal CR
// (and CRLF) to a single LF before anything downstream sees it, so this backend cannot round-trip
// CR — the only escape that survives (`&#xD;`) has to come out of the serializer, and @xmpp/xml does
// not emit it for text nodes. The README documents that as a constraint; this pins the constraint to
// the behaviour of a real server, so a future claim of exact fidelity (or a silent change in the
// library's escaping, which would make the README wrong in the other direction) fails here.

const up = await canAuth(BASE);

const rows: Array<{ name: string; posted: string; readBack: string }> = [
  { name: 'a bare CR', posted: 'a\rb', readBack: 'a\nb' },
  { name: 'a CRLF pair', posted: 'a\r\nb', readBack: 'a\nb' },
  { name: 'CR and CRLF mixed', posted: 'a\rb\r\nc', readBack: 'a\nb\nc' },
  // The neighbours, so the row above is a statement about CR and not about newlines in general.
  { name: 'a bare LF', posted: 'a\nb', readBack: 'a\nb' },
  { name: 'a tab and trailing spaces', posted: '\tx  ', readBack: '\tx  ' },
];

describe.skipIf(!up)('XMPP content fidelity against a real server', () => {
  it.each(rows)('$name is read back exactly as documented', async ({ posted, readBack }) => {
    const plugin = new XmppPlugin();
    await plugin.connect(BASE);
    const topic = freshTopic('fidelity');
    try {
      await plugin.post(topic, asHandle('a'), posted);
      const { messages } = await plugin.fetchRecent({ topic, limit: 5 });
      expect(messages.map((m) => m.content)).toEqual([readBack]);
    } finally {
      await plugin.disconnect();
    }
  }, 40_000);

  it('the live path sees the same bytes as catch-up', async () => {
    const plugin = new XmppPlugin();
    await plugin.connect(BASE);
    const topic = freshTopic('fidelity-live');
    const live: string[] = [];
    try {
      await plugin.subscribe(topic, (m) => live.push(String(m.content)));
      await plugin.post(topic, asHandle('a'), 'a\rb');
      const { messages } = await plugin.fetchRecent({ topic, limit: 5 });
      expect(messages.map((m) => m.content)).toEqual(['a\nb']);
      expect(live).toEqual(['a\nb']);
    } finally {
      await plugin.disconnect();
    }
  }, 40_000);
});
