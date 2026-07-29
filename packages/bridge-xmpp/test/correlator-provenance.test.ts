import { asHandle, asTopic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { describe, expect, it, vi } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { attach, errorEl, FakeXmpp, priv } from './fake-xmpp.js';

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
const NS_MUC_USER = 'http://jabber.org/protocol/muc#user';

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
    const waiter = priv(plugin).armWaiter(room);
    let fired: string | undefined;
    void waiter.park(10_000).then((r) => (fired = r));

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

// Class: the same room key shared by correlators of DIFFERENT KINDS, so a stanza belonging to one
// in-flight operation settles another. A room JID identifies a room, not an operation: a join, a
// post, a long-poll waiter and a MAM collector can all be outstanding on one room at once, and a
// bounce, a reflection, a presence or an archive result each belong to exactly one of them. Any
// fall-through — "this stanza matched no post, so it must be about the join" — reports one
// operation's condition against another, drops a correlator the server has not answered, and does
// it with a diagnostic that names the wrong operation. The table walks (operation in flight) x
// (stanza belonging to a different kind) on the SAME room, and ends every row with the operation's
// OWN stanza as the negative control, so a green row can never be a parse failure.

interface Probe {
  settled(): unknown;
}
interface Ctx {
  plugin: XmppPlugin;
  fake: FakeXmpp;
  room: string;
  originId: string;
}

const bounce = (room: string, id: string, condition = 'not-acceptable'): unknown =>
  xml(
    'message',
    { from: room, type: 'error', id },
    xml('origin-id', { xmlns: NS_SID, id }),
    errorEl(condition, 'no voice'),
  );
const selfPresence = (room: string): unknown =>
  xml(
    'presence',
    { from: `${room}/${OUR_NICK}` },
    xml('x', { xmlns: NS_MUC_USER }, xml('status', { code: '110' })),
  );
const presenceError = (room: string): unknown =>
  xml('presence', { from: `${room}/${OUR_NICK}`, type: 'error' }, errorEl('conflict'));
const liveMessage = (room: string): unknown =>
  reflection({ from: `${room}/someone`, originId: 'unrelated', archId: 'arch-live', room });

const KINDS = ['join', 'post', 'waiter', 'collector'] as const;
type Kind = (typeof KINDS)[number];

/** A stanza of each kind, all addressed to the SAME room the armed operation is using. */
const stanzaOfKind: Record<Kind, (c: Ctx) => unknown> = {
  join: (c) => selfPresence(c.room),
  post: (c) => reflection({ from: `${c.room}/${OUR_NICK}`, originId: c.originId, archId: 'A1', room: c.room }),
  waiter: (c) => liveMessage(c.room),
  collector: (c) => mamResult({ outerFrom: c.room, queryid: 'q-open', archId: 'A2' }),
};

/** Stanzas that belong to NO outstanding operation of their own kind — the fall-through bait. */
const strayOfKind: Record<Kind, (c: Ctx) => unknown> = {
  join: (c) => presenceError(c.room),
  post: (c) => bounce(c.room, 'o-already-cleared'),
  waiter: (c) => liveMessage(c.room),
  collector: (c) => mamResult({ outerFrom: c.room, queryid: 'q-finished', archId: 'A3' }),
};

describe('XMPP correlator kind (a stanza of one kind never settles an operation of another)', () => {
  const arm: Record<Kind, (c: Ctx) => Probe> = {
    join: (c) => {
      let outcome: unknown;
      void priv(c.plugin)
        .joinOnce(c.room)
        .then(
          () => (outcome = 'resolved'),
          (e: Error) => (outcome = e.message),
        );
      return { settled: () => outcome };
    },
    post: (c) => {
      let outcome: unknown;
      void c.plugin.post(TOPIC, asHandle('a'), 'hello').then(
        (id) => (outcome = String(id)),
        (e: Error) => (outcome = e.message),
      );
      return { settled: () => outcome };
    },
    waiter: (c) => {
      let reason: unknown;
      const waiter = priv(c.plugin).armWaiter(c.room);
      void waiter.park(10_000).then((r) => (reason = r));
      return { settled: () => reason };
    },
    collector: (c) => {
      const items: Array<{ archId: string }> = [];
      priv(c.plugin).mamCollectors.set('q-open', { room: c.room, items: items as never });
      return { settled: () => (items.length > 0 ? items : undefined) };
    },
  };

  const pairs = KINDS.flatMap((armed) =>
    KINDS.filter((other) => other !== armed).map((other) => ({ armed, other })),
  );

  it.each(pairs)('an outstanding $armed is not settled by a stray $other stanza', async ({ armed, other }) => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    fake.postReply = 'silent';
    fake.joinReply = 'silent';
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);
    p.joined.set(room, Promise.resolve());
    const ctx: Ctx = { plugin, fake, room, originId: '' };

    const probe = arm[armed](ctx);
    await new Promise((r) => setTimeout(r, 1));
    ctx.originId = [...p.pendingPosts.keys()][0] ?? 'o-none';

    p.onStanza(strayOfKind[other](ctx));
    await new Promise((r) => setTimeout(r, 1));
    expect(probe.settled()).toBeUndefined();

    p.onStanza(stanzaOfKind[armed](ctx));
    await new Promise((r) => setTimeout(r, 1));
    expect(probe.settled()).toBeDefined();

    await plugin.disconnect();
  });
});
