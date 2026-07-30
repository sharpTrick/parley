import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';

// Class: the live path and the catch-up path applying DIFFERENT admission filters to the same
// backend event. A MUC archives more than chat — a subject change, a correction, a retraction and a
// chat state all carry no `<body>` — and `onGroupchat` drops those while `onMamResult` used to store
// them as `content: ''`. The README grades this backend on the two paths being identical, so the
// table describes each archived stanza ONCE and drives it through both, comparing the backendMsgIds
// each returns rather than eyeballing one path.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv } from './fake-xmpp.js';

interface Shape {
  name: string;
  body: string | null;
  subject?: string;
  /** `null` for a room-level stanza: its `from` is the bare room JID, with no occupant resource. */
  sender?: string | null;
  admitted: boolean;
  /** Who the seam must say said it, on BOTH paths. */
  senderHandle?: string;
}

const shapes: Shape[] = [
  { name: 'an ordinary body', body: 'hello', admitted: true, senderHandle: 'someone' },
  // An EMPTY body is a body: the distinction the filter has to make is absent vs empty, and
  // collapsing them would drop a legitimately blank message the live path delivers.
  { name: 'an empty body', body: '', admitted: true, senderHandle: 'someone' },
  { name: 'a body and a subject', body: 'hi', subject: 'sprint 4', admitted: true },
  { name: 'a subject change with no body', body: null, subject: 'sprint 4', admitted: false },
  { name: 'neither a body nor a subject', body: null, admitted: false },
  {
    name: 'a room-level announcement with a body',
    body: 'this room is now members-only',
    sender: null,
    admitted: true,
    senderHandle: 'muc-admission@muc.parley.local',
  },
];

describe('XMPP admits the same archived stanzas via live push and via catch-up', () => {
  it.each(shapes)('$name', async (shape) => {
    const fake = new FakeXmpp();
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'reader' });
    const topic = asTopic('muc-admission');
    const room = priv(plugin).roomJid(topic);
    const live: Message[] = [];
    await plugin.subscribe(topic, (m) => live.push(m));

    const item = fake.deliverItem(room, shape);
    const fetched = (await plugin.fetchRecent({ topic, limit: 10 })).messages;

    const expected = shape.admitted ? [item.archId] : [];
    expect(live.map((m) => String(m.backendMsgId))).toEqual(expected);
    expect(fetched.map((m) => String(m.backendMsgId))).toEqual(expected);
    if (shape.admitted) {
      expect(live[0]?.content).toBe(shape.body);
      expect(fetched[0]?.content).toBe(shape.body);
      if (shape.senderHandle !== undefined) {
        expect([String(live[0]?.senderHandle), String(fetched[0]?.senderHandle)]).toEqual([
          shape.senderHandle,
          shape.senderHandle,
        ]);
      }
    }
    await plugin.disconnect();
    mockState.client = undefined;
  });

  // The filter has to run where it can still see the page's real tail. Filtering inside the MAM
  // decoder makes a page of nothing-but-unadmitted items read as "archive exhausted", and every
  // later message stays behind it forever however often catch-up is retried.
  it('advances the catch-up cursor past a page of stanzas it does not carry', async () => {
    const fake = new FakeXmpp();
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'reader' });
    const topic = asTopic('muc-paging');
    const room = priv(plugin).roomJid(topic);
    priv(plugin).mamPage = 1; // one archived stanza per page, so the bodiless one is a whole page

    const first = fake.archiveItem(room, { body: 'one' });
    fake.archiveItem(room, { body: null, subject: 'sprint 4' });
    const last = fake.archiveItem(room, { body: 'two' });

    const page = await plugin.fetchRecent({ topic, since: first.archId as never, limit: 10 });
    expect(page.messages.map((m) => m.content)).toEqual(['two']);
    expect(String(page.nextCursor)).toBe(last.archId);
    await plugin.disconnect();
    mockState.client = undefined;
  });
});
