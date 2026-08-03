import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { attach, errorEl, expectNoLeaks, FakeXmpp, priv, type XmppPrivate } from './fake-xmpp.js';

// Class: a timeout/callback registered in a KEYED registry tearing down a SUCCESSOR's registration.
// Every correlation map here is single-slot per key (or a set per key), and every entry arms a
// 15 s timer. A reconnect that re-drives an operation while the previous attempt is still in
// flight registers a second entry under the same key — if the loser's timer deletes by key rather
// than by identity, it silently unregisters the winner, and the winner's own event is then ignored
// (a room that is no longer joined, a post that can never be reflected). The table walks each
// registry: register A, register B under the same key, settle A, assert B survives AND still
// completes on its own event.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

const NS_MUC_USER = 'http://jabber.org/protocol/muc#user';
const NS_SID = 'urn:xmpp:sid:0';
const NS_MAM = 'urn:xmpp:mam:2';
const NS_FORWARD = 'urn:xmpp:forward:0';

const TOPIC = asTopic('t-registry');

const selfPresence = (room: string, nick: string): unknown =>
  xml(
    'presence',
    { from: `${room}/${nick}` },
    xml('x', { xmlns: NS_MUC_USER }, xml('status', { code: '110' })),
  );

describe('XMPP keyed correlation registries (a superseded entry never unregisters its successor)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pendingJoins: a re-join registered while the first is in flight survives, and the first settles with it', async () => {
    vi.useFakeTimers();
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    fake.joinReply = 'silent'; // both joins stay in flight until we answer by hand
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);

    const first = p.joinOnce(room);
    const firstOutcome = first.then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(p.pendingJoins.size).toBe(1);

    // The reconnect re-drives the same room 5 s in, so the two entries' 15 s timers are staggered.
    await vi.advanceTimersByTimeAsync(5_000);
    const second = p.joinOnce(room);
    const secondOutcome = second.then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(p.pendingJoins.size).toBe(1);

    // Past the FIRST entry's own 15 s timeout. It is the successor's join that is in flight now, so
    // the loser neither times out nor fails: it waits on the successor like its caller does.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(p.pendingJoins.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1); // the loser's timer went with its registration

    p.onStanza(selfPresence(room, p.nick));
    expect(await secondOutcome).toBe('resolved');
    expect(await firstOutcome).toBe('resolved');
    expect(p.pendingJoins.size).toBe(0);
  });

  it('pendingPosts: one post timing out leaves a concurrent post to the same room correlatable', async () => {
    vi.useFakeTimers();
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    fake.postReply = 'silent';
    const p = attach(plugin, fake);
    p.joined.set(p.roomJid(TOPIC), Promise.resolve());

    const first = plugin.post(TOPIC, asHandle('a'), 'first');
    const firstOutcome = first.then(() => 'resolved', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1);
    const second = plugin.post(TOPIC, asHandle('a'), 'second');
    const secondOutcome = second.then((id) => String(id), (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1);

    const ids = [...p.pendingPosts.keys()];
    expect(ids).toHaveLength(2); // distinct correlators, never a shared slot

    await vi.advanceTimersByTimeAsync(20_000); // both reflection timeouts elapse
    expect(await firstOutcome).toMatch(/timeout/);
    expect(await secondOutcome).toMatch(/timeout/);
    expect(p.pendingPosts.size).toBe(0); // neither timeout left the other's entry behind
  });

  it('mamCollectors: finishing one query does not drop a concurrent query on the same room', async () => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);
    const itemsA: Array<{ archId: string }> = [];
    const itemsB: Array<{ archId: string }> = [];
    p.mamCollectors.set('qa', { room, items: itemsA as never });
    p.mamCollectors.set('qb', { room, items: itemsB as never });

    p.mamCollectors.delete('qa'); // query A's finally-block teardown

    expect(p.mamCollectors.has('qb')).toBe(true);
    p.onStanza(
      xml(
        'message',
        { from: room },
        xml(
          'result',
          { xmlns: NS_MAM, queryid: 'qb', id: 'arch-b' },
          xml(
            'forwarded',
            { xmlns: NS_FORWARD },
            xml('message', { from: `${room}/x` }, xml('body', {}, 'b')),
          ),
        ),
      ),
    );
    expect(itemsB.map((i) => i.archId)).toEqual(['arch-b']);
  });

  it('waiters: one long-poll timing out leaves a concurrent long-poll on the same room armed', async () => {
    vi.useFakeTimers();
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);

    const shortWait = p.armWaiter(room);
    const shortFired = shortWait.park(100);
    const longWait = p.armWaiter(room);
    let longFired: string | undefined;
    void longWait.park(10_000).then((r) => {
      longFired = r;
    });
    expect(p.waiters.get(room)?.size).toBe(2);

    await vi.advanceTimersByTimeAsync(200);
    expect(await shortFired).toBe('timeout');
    expect(p.waiters.get(room)?.size).toBe(1); // the survivor is still registered

    p.onStanza(
      xml(
        'message',
        { from: `${room}/other`, type: 'groupchat' },
        xml('body', {}, 'hi'),
        xml('stanza-id', { xmlns: NS_SID, by: room, id: 'arch-1' }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(longFired).toBe('message'); // still woken by its own event
    expectNoLeaks(plugin);
  });
});

// Class: a superseded entry settled through a route that is NOT its own timer. The table above only
// ever walks the `own timeout` column, and for pendingJoins that column cannot fail: `settleFrom`
// disarms the loser's timer the moment a successor registers, so the loser's own timeout can never
// reach the delete. The identity guard on that delete therefore had no case that could fail against
// it — replacing it with an unconditional `delete(room)` left the whole suite green, while in
// production it drops the SUCCESSOR's registration, its self-presence is ignored, and the room is
// silently unjoined: live push for the topic dead and every post to it bouncing.
//
// Each row supersedes an in-flight join and then settles one of the two entries by a route that is
// not a timer, demanding the same shape of every one: both callers settle, the registry ends empty,
// and — where the route left the successor registered — the successor still completes on its own
// self-presence. A new route is a row, not a new test.

/** Bounded wait: a registration a route destroyed never completes, and must not cost the timeout. */
const settleWithin = async (p: Promise<unknown>, ms: number): Promise<string> =>
  Promise.race([
    p.then(
      () => 'settled',
      (e: Error) => `settled: ${e.message}`,
    ),
    new Promise<string>((r) => setTimeout(() => r('still pending'), ms)),
  ]);

interface Route {
  name: string;
  /** Settle one of the two entries. `failLoserSend` rejects the loser's own in-flight `send`. */
  fire(ctx: {
    plugin: XmppPlugin;
    p: XmppPrivate;
    room: string;
    failLoserSend: (err: Error) => void;
  }): Promise<void> | void;
  /** Whether the successor is still registered afterwards, waiting for its own self-presence. */
  successorSurvives: boolean;
}

const routes: Route[] = [
  {
    // The one route that actually reaches the loser: its own transport failing late. It is the
    // reason the delete has to be identity-guarded, and nothing exercised it.
    name: "the loser's own send rejecting after the successor registered",
    fire: ({ failLoserSend }) => {
      failLoserSend(new Error('stream closed'));
    },
    successorSurvives: true,
  },
  {
    name: 'an error presence naming the nick both joins asked for',
    fire: ({ p, room }) => {
      p.onStanza(
        xml('presence', { from: `${room}/${p.nick}`, type: 'error' }, errorEl('forbidden')),
      );
    },
    successorSurvives: false,
  },
  {
    name: 'a disconnect while both are outstanding',
    fire: async ({ plugin }) => {
      await plugin.disconnect();
    },
    successorSurvives: false,
  },
];

describe('XMPP a superseded join settled off its timer leaves the successor registered', () => {
  it.each(routes)('$name', async (route) => {
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    fake.joinReply = 'silent'; // neither join is answered until this case says so
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);

    let failLoserSend!: (err: Error) => void;
    const pass = fake.send.bind(fake);
    let sends = 0;
    fake.send = async (el: unknown) => {
      await pass(el);
      if (++sends > 1) return;
      // The loser's send is left in flight, so that its LATE failure — the only path that reaches
      // a superseded entry — is a thing this case can schedule rather than race.
      await new Promise<void>((_resolve, reject) => {
        failLoserSend = reject;
      });
    };

    const loser = p.joinOnce(room);
    const loserOutcome = settleWithin(loser, 500);
    await Promise.resolve();
    const successor = p.joinOnce(room);
    const successorOutcome = settleWithin(successor, 500);
    expect(p.pendingJoins.size).toBe(1);

    await route.fire({ plugin, p, room, failLoserSend });
    await Promise.resolve();

    if (route.successorSurvives) {
      expect(p.pendingJoins.size, 'the successor was unregistered by the loser').toBe(1);
      p.onStanza(selfPresence(room, p.nick));
      expect(await successorOutcome).toBe('settled');
    } else {
      expect(await successorOutcome).toMatch(/^settled/);
    }
    expect(await loserOutcome).toMatch(/^settled/);
    expect(p.pendingJoins.size).toBe(0);
    expectNoLeaks(plugin);
  }, 15_000);
});

// Class: an operation that registers a keyed correlator and arms a timer BEFORE the step that can
// fail synchronously. `joinOnce` registered its pendingJoins entry and a 15 s timer and only then
// resolved the connection, so any seam call on a plugin that is not serving — never connected, or
// stopped — left both behind: the slot self-cleared 15 s later, holding the event loop open past
// shutdown and leaving a live correlator that a stray self-presence for that room could resolve.
// The table crosses every seam entry point with every not-serving state; each must settle and leave
// every registry empty with no timer armed.

const CONFIG = { password: 'a-real-secret', nick: 'registry' };

interface Entry {
  name: string;
  settles: 'rejects' | 'resolves';
  call(plugin: XmppPlugin): Promise<unknown>;
}
const entries: Entry[] = [
  { name: 'post', settles: 'rejects', call: (p) => p.post(TOPIC, asHandle('a'), 'x') },
  { name: 'fetchRecent', settles: 'rejects', call: (p) => p.fetchRecent({ topic: TOPIC }) },
  {
    name: 'fetchRecent with blockMs',
    settles: 'rejects',
    call: (p) => p.fetchRecent({ topic: TOPIC, since: asCursor('arch-1'), blockMs: 30_000 }),
  },
  { name: 'subscribe', settles: 'rejects', call: (p) => p.subscribe(TOPIC, () => undefined) },
  { name: 'resolveIdentity', settles: 'resolves', call: (p) => p.resolveIdentity(asHandle('a')) },
];

const states: Array<{ name: string; reach(plugin: XmppPlugin, fake: FakeXmpp): Promise<void> }> = [
  { name: 'never connected', reach: async () => undefined },
  {
    name: 'after disconnect',
    reach: async (plugin) => {
      await plugin.connect(CONFIG);
      await plugin.post(TOPIC, asHandle('a'), 'before');
      await plugin.disconnect();
    },
  },
];
const notServing = states.flatMap((state) => entries.map((entry) => ({ state, entry })));

describe('XMPP seam calls on a plugin that is not serving arm nothing', () => {
  afterEach(() => {
    vi.useRealTimers();
    mockState.client = undefined;
  });

  it.each(notServing)('$entry.name $state.name', async ({ state, entry }) => {
    vi.useFakeTimers();
    const fake = new FakeXmpp();
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await state.reach(plugin, fake);

    const settled = await entry.call(plugin).then(
      () => 'resolves',
      () => 'rejects',
    );

    expect(settled).toBe(entry.settles);
    expectNoLeaks(plugin);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a disconnect racing an in-flight join settles it and leaves nothing armed', async () => {
    vi.useFakeTimers();
    const fake = new FakeXmpp();
    fake.joinReply = 'silent'; // the join stays in flight until we tear the plugin down
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect(CONFIG);

    const posted = plugin.post(TOPIC, asHandle('a'), 'x');
    await vi.advanceTimersByTimeAsync(1);
    expect(priv(plugin).pendingJoins.size).toBe(1);

    await plugin.disconnect();
    await expect(posted).rejects.toThrow();
    expectNoLeaks(plugin);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a seam call arriving while disconnect is still closing the stream arms nothing', async () => {
    vi.useFakeTimers();
    const fake = new FakeXmpp();
    mockState.client = fake;
    let closed!: () => void;
    fake.stop = () =>
      new Promise<void>((r) => {
        closed = r;
      });
    const plugin = new XmppPlugin();
    await plugin.connect(CONFIG);
    await plugin.post(TOPIC, asHandle('a'), 'before');

    const closing = plugin.disconnect(); // parked inside xmpp.stop(), so `xmpp` is still set
    await expect(plugin.post(TOPIC, asHandle('a'), 'during')).rejects.toThrow(/not connected/);
    expectNoLeaks(plugin);
    expect(vi.getTimerCount()).toBe(0);

    closed();
    await closing;
  });
});

// Class: a correlator/timer registered BEFORE a step that can fail, where the failure path returns
// the caller's error without settling the registration. The states above only reach failures that
// happen before anything is registered; this table reaches the ones that happen after, by breaking
// the transport at each stage of a call the plugin has already committed to.
//
// The `unhandledRejection` collector is the part that generalises past any one line: a promise
// created before a failable await and then abandoned rejects with nobody holding it, which under
// Node's default `--unhandled-rejections=throw` kills the bridge process. It catches that shape
// anywhere in the plugin, whether the orphan rejects on its own timer, on `disconnect()`, or on a
// reconnect.

interface TransportFault {
  name: string;
  apply(fake: FakeXmpp): void;
}
const faults: TransportFault[] = [
  {
    name: 'send() rejects',
    apply: (fake) => {
      fake.send = () => Promise.reject(new Error('stream closed'));
    },
  },
  {
    name: 'send() throws synchronously',
    apply: (fake) => {
      fake.send = () => {
        throw new Error('stream closed');
      };
    },
  },
  {
    name: 'iqCaller.request() rejects',
    apply: (fake) => {
      fake.iqCaller.request = () => Promise.reject(new Error('stream closed'));
    },
  },
];

const rooms: Array<{ name: string; reach(plugin: XmppPlugin): Promise<void> }> = [
  {
    name: 'with the room already joined',
    reach: async (p) => {
      await p.post(TOPIC, asHandle('a'), 'seed');
    },
  },
  { name: 'with the room not joined yet', reach: async () => undefined },
];

const brokenTransport = faults.flatMap((fault) =>
  rooms.flatMap((room) =>
    entries
      .filter((entry) => entry.name !== 'resolveIdentity')
      .map((entry) => ({ fault, room, entry })),
  ),
);

describe('XMPP seam calls whose transport fails mid-call leave nothing behind', () => {
  afterEach(() => {
    vi.useRealTimers();
    mockState.client = undefined;
  });

  it.each(brokenTransport)('$entry.name $room.name when $fault.name', async ({
    fault,
    room,
    entry,
  }) => {
    const orphans: unknown[] = [];
    const collect = (err: unknown): void => {
      orphans.push(err);
    };
    process.on('unhandledRejection', collect);
    try {
      vi.useFakeTimers();
      const fake = new FakeXmpp();
      mockState.client = fake;
      const plugin = new XmppPlugin();
      await plugin.connect(CONFIG);
      await room.reach(plugin);
      fault.apply(fake);

      let settled = false;
      const mark = (): void => {
        settled = true;
      };
      void entry.call(plugin).then(mark, mark);
      // A blocking fetch parks for its whole budget, so give every entry point the room to finish
      // on its own terms — but stop the moment it does, so that a registry entry cleared by its own
      // 15 s timeout cannot pass for one the failure path settled.
      await vi.advanceTimersByTimeAsync(0);
      for (let waited = 0; !settled && waited < 90_000; waited += 1_000) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(settled, 'the seam call never settled').toBe(true);
      expectNoLeaks(plugin);
      expect(vi.getTimerCount()).toBe(0);

      // Past every correlator's own timeout, then a teardown: the two moments an abandoned
      // promise created earlier in the call would reject with nobody left holding it.
      await vi.advanceTimersByTimeAsync(60_000);
      await plugin.disconnect();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(orphans.map(String)).toEqual([]);
    } finally {
      process.off('unhandledRejection', collect);
    }
  });
});
