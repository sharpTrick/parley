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
import { type ArchiveItem, FakeXmpp, priv } from './fake-xmpp.js';

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

// Class: `limit` counted in BACKEND ROWS rather than in the messages the seam carries, and a window
// whose admitted set is empty then reporting a cursor that precedes what this plugin has already
// read. Both arms of `since` face both halves, and each got one wrong in its own way: the
// `since`-given arm pages until it holds `limit` MESSAGES, while the since-less arm read a single
// page of `limit` ARCHIVE ROWS and filtered afterwards — so a room whose recent history is subject
// changes, corrections or moderation tombstones answered with fewer messages than it holds, or with
// none at all, and `''` (the zero cursor — "this room's archive from message one") then replayed
// the whole room on the next call. Both expectations are therefore derived from the ADMITTED
// messages rather than from a fixed row window, so that no arm can satisfy the table by counting
// rows, and a tail made of anything the seam drops cannot decide how much of a room a reader sees.

type Arm = 'no cursor' | 'the zero cursor' | 'a real archive id';
type Tail =
  | 'all bodied'
  | 'a bodiless last row'
  | 'a wholly bodiless tail'
  | 'a bodiless run longer than the window'
  | 'a wholly bodiless archive';

const bodies: Record<Tail, Array<string | null>> = {
  'all bodied': ['b1', 'b2', 'b3', 'b4'],
  'a bodiless last row': ['b1', 'b2', 'b3', null],
  'a wholly bodiless tail': ['b1', 'b2', null, null],
  // A bodiless run LONGER than the window is the only shape that tells "read one page of `limit`
  // rows" apart from "page until `limit` messages": nothing the first reads is admitted at all.
  'a bodiless run longer than the window': ['b1', 'b2', null, null, null, null, null],
  'a wholly bodiless archive': [null, null, null, null],
};

/** `limit` small enough that the since-LESS window is the archive tail, and only it. */
const TAIL_WINDOW = 2;

/**
 * The rows each arm's read covers — derived, so a change to either axis moves the expectation. The
 * since-less arm walks BACKWARDS from the tail until it holds TAIL_WINDOW admitted messages, so its
 * window starts at the oldest row it had to reach and not at a fixed offset from the end.
 */
const windowOf = (archive: ArchiveItem[], arm: Arm): ArchiveItem[] => {
  if (arm === 'the zero cursor') return archive;
  if (arm === 'a real archive id') return archive.slice(1);
  const bodied = archive.flatMap((it, i) => (it.body === null ? [] : [i]));
  return archive.slice(bodied.length > TAIL_WINDOW ? bodied[bodied.length - TAIL_WINDOW]! : 0);
};

const cursorRows = (Object.keys(bodies) as Tail[]).flatMap((tail) =>
  (['no cursor', 'the zero cursor', 'a real archive id'] as Arm[]).map((arm) => ({ arm, tail })),
);

describe('XMPP catch-up cursor never moves back past what it has already read', () => {
  it.each(cursorRows)('$arm over $tail', async ({ arm, tail }) => {
    const fake = new FakeXmpp();
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'reader' });
    const topic = asTopic('muc-cursor');
    const room = priv(plugin).roomJid(topic);
    const archive = bodies[tail].map((body) => fake.archiveItem(room, { body }));

    const window = windowOf(archive, arm);
    const admitted = window.filter((it) => it.body !== null);
    const since =
      arm === 'no cursor' ? undefined : arm === 'the zero cursor' ? '' : archive[0]!.archId;

    const page = await plugin.fetchRecent({
      topic,
      ...(since === undefined ? {} : { since: since as never }),
      limit: arm === 'no cursor' ? TAIL_WINDOW : 100,
    });

    expect(page.messages.map((m) => m.content)).toEqual(admitted.map((it) => it.body));
    // The cursor is the last row the read RETURNED, or — when it returned none — the last row it
    // SAW. Never the caller's own cursor, and never '', both of which sit behind the window.
    expect(String(page.nextCursor)).toBe((admitted.at(-1) ?? window.at(-1))!.archId);

    // Feeding it back must deliver only what arrived afterwards: nothing the window already
    // covered, and nothing from the archive prefix the window deliberately skipped.
    const fresh = fake.archiveItem(room, { body: 'after' });
    const replay = await plugin.fetchRecent({ topic, since: page.nextCursor, limit: 100 });
    expect(replay.messages.map((m) => m.content)).toEqual(['after']);
    expect(String(replay.nextCursor)).toBe(fresh.archId);

    await plugin.disconnect();
    mockState.client = undefined;
  });
});
