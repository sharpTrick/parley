import { asCursor, asTopic, type Topic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { describe, expect, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';

// BUG-05 — empty-archive zero cursor. `fetchRecent` on a fresh/empty MUC returns the zero cursor
// `''`; core persists it and feeds it back as `since`. The plugin must treat an empty/undefined
// `since` as "from the very beginning" — a plain forward MAM query with NO `<after/>` — never
// round-trip `''` as an RSM UID (which modern servers reject with item-not-found, bricking every
// restart). These assertions are pure functions of the emitted IQ, so they run without a server.

const NS_MAM = 'urn:xmpp:mam:2';
const NS_RSM = 'http://jabber.org/protocol/rsm';

interface El {
  attrs: Record<string, string>;
  getChild(name: string, ns?: string): El | undefined;
  getChildText(name: string, ns?: string): string | null;
}
interface XmppPrivate {
  xmpp?: unknown;
  joined: Map<string, Promise<void>>;
  roomJid(topic: Topic): string;
}
const priv = (p: XmppPlugin): XmppPrivate => p as unknown as XmppPrivate;

/**
 * A fake @xmpp client that captures every MAM `<iq>` and answers an immediately-complete `<fin>`,
 * so `mamQuery`/`fetchRecent` resolve against an "empty archive" without a broker.
 */
const makeCapturingClient = (): { iqs: El[]; iqCaller: { request(el: unknown): Promise<El> } } => {
  const iqs: El[] = [];
  return {
    iqs,
    iqCaller: {
      request: async (el: unknown): Promise<El> => {
        iqs.push(el as El);
        return xml(
          'iq',
          { type: 'result' },
          xml('fin', { xmlns: NS_MAM, complete: 'true' }),
        ) as unknown as El;
      },
    },
  };
};

/** The RSM `<set>` of the captured MAM query. */
const rsmOf = (iq: El): El | undefined => iq.getChild('query', NS_MAM)?.getChild('set', NS_RSM);

describe('XMPP empty-archive catch-up zero cursor (BUG-05)', () => {
  it("treats an empty since ('') as forward-from-beginning: emits NO <after/>, resolves without item-not-found", async () => {
    const plugin = new XmppPlugin();
    const fake = makeCapturingClient();
    priv(plugin).xmpp = fake;
    // Skip the live MUC join handshake — pre-seed the ensureJoined cache as already resolved.
    const room = priv(plugin).roomJid(asTopic('t'));
    priv(plugin).joined.set(room, Promise.resolve());

    // Previously this threw item-not-found (empty <after/> sent to the archive). It must resolve.
    const res = await plugin.fetchRecent({ topic: asTopic('t'), since: asCursor('') });

    expect(res.messages).toHaveLength(0);
    // Empty archive re-persists '' idempotently (now harmless — never sent as an RSM UID).
    expect(String(res.nextCursor)).toBe('');
    // Exactly one forward page, and it carries NO <after> child (start-of-archive).
    expect(fake.iqs).toHaveLength(1);
    expect(rsmOf(fake.iqs[0]!)?.getChildText('after')).toBeNull();
  });

  it('treats an undefined since as the most-recent window: NO <after/>, empty <before/>, resolves', async () => {
    const plugin = new XmppPlugin();
    const fake = makeCapturingClient();
    priv(plugin).xmpp = fake;
    const room = priv(plugin).roomJid(asTopic('t'));
    priv(plugin).joined.set(room, Promise.resolve());

    const res = await plugin.fetchRecent({ topic: asTopic('t') });

    expect(res.messages).toHaveLength(0);
    expect(fake.iqs).toHaveLength(1);
    const set = rsmOf(fake.iqs[0]!);
    expect(set?.getChildText('after')).toBeNull(); // no cursor => no <after>
    expect(set?.getChild('before')).toBeDefined(); // last-page window => empty <before/>
  });

  it('still emits <after> for a real (non-empty) archive cursor — the guard is scoped to ""', async () => {
    // Mutation guard: the fix must NOT drop <after> for legitimate catch-up cursors.
    const plugin = new XmppPlugin();
    const fake = makeCapturingClient();
    priv(plugin).xmpp = fake;
    const room = priv(plugin).roomJid(asTopic('t'));
    priv(plugin).joined.set(room, Promise.resolve());

    await plugin.fetchRecent({ topic: asTopic('t'), since: asCursor('real-arch-42') });

    expect(rsmOf(fake.iqs[0]!)?.getChildText('after')).toBe('real-arch-42');
  });
});
