import { asTopic, type Topic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { describe, expect, it } from 'vitest';
import { XmppPlugin } from '../src/index.js';

// SEC-13 — XMPP MAM result provenance. `onMamResult` must accept a streamed
// `<result xmlns='urn:xmpp:mam:2'>` item ONLY when the outer message stanza's bare `from`
// equals the room JID the in-flight query targeted; a result from any other JID is dropped
// (never pushed into the collector, never returned from fetchRecent). And the query correlator
// (`queryid`) must be a crypto UUID, not a Math.random() token. These are pure functions of the
// parsed stanza / query setup, so they run without a live server.

const NS_MAM = 'urn:xmpp:mam:2';
const NS_FORWARD = 'urn:xmpp:forward:0';
const NS_DELAY = 'urn:xmpp:delay';

interface MamItem {
  archId: string;
  from: string;
  body: string;
  stamp?: string;
}

/** Reach into the plugin's private surface via a typed cast (mirrors the spec's "typed cast" seam). */
interface XmppPrivate {
  stopped: boolean;
  mamCollectors: Map<string, { room: string; items: MamItem[] }>;
  onStanza(stanza: unknown): void;
  mamQuery(
    topic: Topic,
    opts: { after?: string; before?: boolean; max: number },
  ): Promise<{ items: MamItem[]; complete: boolean }>;
  xmpp?: unknown;
}
const priv = (p: XmppPlugin): XmppPrivate => p as unknown as XmppPrivate;

/**
 * A forwarded MAM `<result>` wrapped in an outer `message` stanza, exactly as a server (or an
 * off-path attacker) would push it into the session. `outerFrom` is the stanza-level `from`
 * whose bare JID provenance is (or is not) verified.
 */
const mamResultMessage = (opts: {
  outerFrom: string;
  queryid: string;
  archId: string;
  innerFrom: string;
  body: string;
  stamp?: string;
}): unknown =>
  xml(
    'message',
    { from: opts.outerFrom },
    xml(
      'result',
      { xmlns: NS_MAM, queryid: opts.queryid, id: opts.archId },
      xml(
        'forwarded',
        { xmlns: NS_FORWARD },
        ...(opts.stamp !== undefined
          ? [xml('delay', { xmlns: NS_DELAY, stamp: opts.stamp })]
          : []),
        xml('message', { from: opts.innerFrom }, xml('body', {}, opts.body)),
      ),
    ),
  );

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('XMPP MAM result provenance (SEC-13)', () => {
  const ROOM = 'myroom@muc.parley.local';
  const QUERYID = 'live-query-id-abc123';

  it('drops a <result> whose outer from is NOT the queried room, and keeps the legitimate one', () => {
    const plugin = new XmppPlugin();
    const items: MamItem[] = [];
    // Register a live collector bound to ROOM, as mamQuery would.
    priv(plugin).mamCollectors.set(QUERYID, { room: ROOM, items });

    const evil = mamResultMessage({
      outerFrom: 'evil@example.com/attacker', // bare -> evil@example.com != ROOM
      queryid: QUERYID, // attacker knows/guesses the live queryid
      archId: 'FORGED-ARCH-9999',
      innerFrom: `${ROOM}/victim`,
      body: 'fabricated history injected by an off-path entity',
    });
    const legit = mamResultMessage({
      outerFrom: `${ROOM}/alice`, // bare -> ROOM == collector.room
      queryid: QUERYID,
      archId: 'real-arch-0001',
      innerFrom: `${ROOM}/alice`,
      body: 'genuine archived message',
      stamp: '2026-07-06T00:00:00Z',
    });

    // Feed the attacker stanza FIRST (worst case: it would win if unchecked), then the legit one.
    priv(plugin).onStanza(evil);
    priv(plugin).onStanza(legit);

    // Only the room's own result survived; the foreign archive was rejected outright.
    expect(items).toHaveLength(1);
    expect(items[0]?.archId).toBe('real-arch-0001');
    expect(items[0]?.body).toBe('genuine archived message');
    // The forged archId (which would derail <after> paging as a forged cursor) never landed.
    expect(items.map((i) => i.archId)).not.toContain('FORGED-ARCH-9999');
    expect(items.some((i) => i.body.includes('fabricated'))).toBe(false);
  });

  it('proves the drop is the provenance check, not a parse failure: the SAME attacker stanza IS collected when its from matches the queried room', () => {
    // Negative control / mutation guard. Bind the collector to the attacker's own JID so the
    // outer-from check passes for the exact stanza the previous test rejected. If it now collects,
    // the earlier rejection was caused specifically by `fromBare !== collector.room` — not by a
    // malformed/unparseable stanza. This is what makes the green suite genuine.
    const plugin = new XmppPlugin();
    const items: MamItem[] = [];
    priv(plugin).mamCollectors.set(QUERYID, { room: 'evil@example.com', items });

    const evil = mamResultMessage({
      outerFrom: 'evil@example.com/attacker',
      queryid: QUERYID,
      archId: 'FORGED-ARCH-9999',
      innerFrom: `${ROOM}/victim`,
      body: 'fabricated history injected by an off-path entity',
    });
    priv(plugin).onStanza(evil);

    expect(items).toHaveLength(1);
    expect(items[0]?.archId).toBe('FORGED-ARCH-9999');
  });

  it('generates the MAM queryid with crypto.randomUUID(), not Math.random()', async () => {
    const plugin = new XmppPlugin();

    // Fake @xmpp client: capture the queryid off the outgoing MAM <query> IQ and return an
    // immediately-complete <fin> so mamQuery resolves without a broker.
    let capturedQueryid: string | undefined;
    const fakeClient = {
      iqCaller: {
        request: async (el: {
          getChild(name: string, ns?: string): { attrs: Record<string, string> } | undefined;
        }) => {
          capturedQueryid = el.getChild('query', NS_MAM)?.attrs.queryid;
          return xml('iq', { type: 'result' }, xml('fin', { xmlns: NS_MAM, complete: 'true' }));
        },
      },
    };
    priv(plugin).xmpp = fakeClient;

    const res = await priv(plugin).mamQuery(asTopic('room1'), { max: 200 });
    expect(res.complete).toBe(true);

    expect(capturedQueryid).toBeDefined();
    // The Math.random() token was `q-...`; a crypto UUID matches the canonical UUID shape.
    expect(capturedQueryid).toMatch(UUID_RE);
    expect(capturedQueryid?.startsWith('q-')).toBe(false);

    // And the collector was registered under that UUID for the duration of the query
    // (deleted again in mamQuery's finally, so the map is empty once it resolves).
    expect(priv(plugin).mamCollectors.size).toBe(0);
  });
});
