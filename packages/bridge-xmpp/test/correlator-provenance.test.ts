import { asHandle, asTopic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { describe, expect, it, vi } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { attach, FakeXmpp, priv } from './fake-xmpp.js';

// Class: a correlator matched on a token the ATTACKER CAN SEE, without verifying who sent the
// stanza carrying it. Every in-flight operation here is keyed by a token that travels through the
// room (origin-id on the wire in every post, queryid in every MAM result) or by the room JID
// itself, so a co-occupant can echo one back. Resolving on it without a sender check lets another
// occupant decide our post's backendMsgId/cursor, inject archive history, or wake/feed a topic it
// does not belong to. The table feeds each correlator a well-formed stanza bearing the RIGHT token
// and a WRONG `from`, and demands nothing is resolved, collected, or delivered — each with the
// same-shaped legitimate stanza as a negative control, so a green row can never be a parse failure.

const NS_SID = 'urn:xmpp:sid:0';
const NS_MAM = 'urn:xmpp:mam:2';
const NS_FORWARD = 'urn:xmpp:forward:0';

const TOPIC = asTopic('t-prov');
const OUR_NICK = 'parley-test';

const reflection = (opts: { from: string; originId: string; archId: string; room: string }): unknown =>
  xml(
    'message',
    { from: opts.from, type: 'groupchat' },
    xml('body', {}, 'hello'),
    xml('origin-id', { xmlns: NS_SID, id: opts.originId }),
    xml('stanza-id', { xmlns: NS_SID, by: opts.room, id: opts.archId }),
  );

const mamResult = (opts: { outerFrom: string; queryid: string; archId: string }): unknown =>
  xml(
    'message',
    { from: opts.outerFrom },
    xml(
      'result',
      { xmlns: NS_MAM, queryid: opts.queryid, id: opts.archId },
      xml(
        'forwarded',
        { xmlns: NS_FORWARD },
        xml('message', { from: `${opts.outerFrom}/x` }, xml('body', {}, 'body')),
      ),
    ),
  );

describe('XMPP correlator provenance (a right token from a wrong sender settles nothing)', () => {
  const setup = (): { plugin: XmppPlugin; fake: FakeXmpp; room: string } => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    fake.postReply = 'silent';
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);
    p.joined.set(room, Promise.resolve());
    return { plugin, fake, room };
  };

  /** `from` values a co-occupant or a foreign entity can put on an otherwise valid reflection. */
  const foreignSenders = (room: string): Array<{ name: string; from: string }> => [
    { name: 'another occupant of our room', from: `${room}/attacker` },
    { name: 'our nick in a DIFFERENT room', from: `other@muc.parley.local/${OUR_NICK}` },
    { name: 'a bare JID with no resource', from: room },
    { name: 'an unrelated bare JID', from: 'evil@example.com' },
    { name: 'no from at all', from: '' },
  ];

  it.each(foreignSenders('t-prov@muc.parley.local'))(
    'origin-id -> pendingPosts: a reflection from $name does not resolve our post',
    async ({ from }) => {
      vi.useFakeTimers();
      try {
        const { plugin, room } = setup();
        let settled: string | undefined;
        void plugin.post(TOPIC, asHandle('a'), 'hello').then(
          (id) => (settled = String(id)),
          (e: Error) => (settled = `rejected: ${e.message}`),
        );
        await vi.advanceTimersByTimeAsync(1);
        const originId = [...priv(plugin).pendingPosts.keys()][0]!;

        priv(plugin).onStanza(
          reflection({ from, originId, archId: 'ATTACKER-ARCHIVE-ID', room }),
        );
        await vi.advanceTimersByTimeAsync(1);

        expect(settled).toBeUndefined();
        expect(priv(plugin).pendingPosts.size).toBe(1);

        // Negative control: the SAME stanza from our own occupant JID does resolve it, so the
        // rejection above is the provenance check and not a malformed/ignored stanza.
        priv(plugin).onStanza(
          reflection({ from: `${room}/${OUR_NICK}`, originId, archId: 'REAL-ARCH', room }),
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe('REAL-ARCH');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { name: 'another occupant', outerFrom: 'evil@example.com' },
    { name: 'a different room', outerFrom: 'other@muc.parley.local' },
  ])('queryid -> mamCollectors: a <result> from $name is not collected', ({ outerFrom }) => {
    const { plugin, room } = setup();
    const items: Array<{ archId: string }> = [];
    priv(plugin).mamCollectors.set('q1', { room, items: items as never });

    priv(plugin).onStanza(mamResult({ outerFrom, queryid: 'q1', archId: 'FORGED' }));
    expect(items).toHaveLength(0);

    priv(plugin).onStanza(mamResult({ outerFrom: room, queryid: 'q1', archId: 'REAL' }));
    expect(items.map((i) => i.archId)).toEqual(['REAL']);
  });

  it('room -> waiters/subscriptions: a groupchat message from another room neither wakes nor delivers', async () => {
    const { plugin, room } = setup();
    const seen: string[] = [];
    await plugin.subscribe(TOPIC, (m) => seen.push(m.content));
    const waiter = priv(plugin).armWaiter(room, 10_000);
    let fired: string | undefined;
    void waiter.fired.then((r) => (fired = r));

    priv(plugin).onStanza(
      reflection({
        from: 'other@muc.parley.local/someone',
        originId: 'unrelated',
        archId: 'arch-x',
        room: 'other@muc.parley.local',
      }),
    );
    await Promise.resolve();

    expect(seen).toEqual([]);
    expect(fired).toBeUndefined();

    priv(plugin).onStanza(
      reflection({ from: `${room}/someone`, originId: 'unrelated', archId: 'arch-y', room }),
    );
    await Promise.resolve();
    expect(seen).toEqual(['hello']);
    expect(fired).toBe('message');
    await plugin.disconnect();
  });

  it('mints correlators from crypto, not Math.random', async () => {
    vi.useFakeTimers();
    try {
      const { plugin } = setup();
      void plugin.post(TOPIC, asHandle('a'), 'hello').catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1);
      const originId = [...priv(plugin).pendingPosts.keys()][0]!;
      expect(originId).toMatch(
        /^o-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      // The default nick is published in the room on every post, so it must not leak PRNG state.
      const fresh = new XmppPlugin();
      expect(priv(fresh).nick).toMatch(/^parley-[0-9a-f]{16}$/);
      await plugin.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});
