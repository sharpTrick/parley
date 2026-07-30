import { asCursor, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { attach, type El, FakeXmpp, priv } from './fake-xmpp.js';

// Empty-archive zero cursor. `fetchRecent` on a fresh/empty MUC returns the zero cursor
// `''`; core persists it and feeds it back as `since`. The plugin must treat an empty/undefined
// `since` as "from the very beginning" — a plain forward MAM query with NO `<after/>` — never
// round-trip `''` as an RSM UID (which modern servers reject with item-not-found, bricking every
// restart). The table reads the emitted IQ off the SHARED fake, which enforces the wire contract
// (XML well-formedness, occupancy, reflection stamping) that a per-file capturing client does not.

const NS_MAM = 'urn:xmpp:mam:2';
const NS_RSM = 'http://jabber.org/protocol/rsm';

const TOPIC = asTopic('t');

/** The RSM `<set>` of the captured MAM query. */
const rsmOf = (iq: El): El | undefined => iq.getChild('query', NS_MAM)?.getChild('set', NS_RSM);

interface Row {
  name: string;
  since?: string;
  /** The `<after>` UID the query must carry, or `null` for "no <after> child at all". */
  after: string | null;
  /** Whether the query asks for the LAST page (an empty `<before/>`) rather than a forward window. */
  lastPage: boolean;
}

const rows: Row[] = [
  {
    name: "an empty since ('') is forward-from-beginning, never an RSM UID",
    since: '',
    after: null,
    lastPage: false,
  },
  { name: 'an undefined since is the most-recent window', after: null, lastPage: true },
  {
    name: 'a real archive cursor still pages forward from it — the guard is scoped to ""',
    since: 'real-arch-42',
    after: 'real-arch-42',
    lastPage: false,
  },
];

describe('XMPP empty-archive catch-up zero cursor', () => {
  it.each(rows)('$name', async ({ since, after, lastPage }) => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    // Skip the live MUC join handshake — pre-seed the ensureJoined cache as already resolved.
    attach(plugin, fake, priv(plugin).roomJid(TOPIC));

    const res = await plugin.fetchRecent({
      topic: TOPIC,
      ...(since === undefined ? {} : { since: asCursor(since) }),
    });

    expect(res.messages).toHaveLength(0);
    // An empty archive re-persists the caller's own cursor idempotently.
    expect(String(res.nextCursor)).toBe(since ?? '');
    expect(fake.sentIqs).toHaveLength(1); // exactly one page, no probe round trip on a joined room
    const set = rsmOf(fake.sentIqs[0] as El);
    expect(set?.getChildText('after')).toBe(after);
    expect(set?.getChild('before') === undefined).toBe(!lastPage);
    expect(fake.alive).toBe(true); // nothing illegal reached the stream
  });
});
