import { asHandle, asTopic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { attach, expectNoLeaks, FakeXmpp } from './fake-xmpp.js';

// Class: a timeout/callback registered in a KEYED registry tearing down a SUCCESSOR's registration.
// Every correlation map here is single-slot per key (or a set per key), and every entry arms a
// 15 s timer. A reconnect that re-drives an operation while the previous attempt is still in
// flight registers a second entry under the same key — if the loser's timer deletes by key rather
// than by identity, it silently unregisters the winner, and the winner's own event is then ignored
// (a room that is no longer joined, a post that can never be reflected). The table walks each
// registry: register A, register B under the same key, settle A, assert B survives AND still
// completes on its own event.

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

  it('pendingJoins: a re-join registered while the first is in flight survives the first timing out', async () => {
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

    await vi.advanceTimersByTimeAsync(11_000); // past the FIRST entry's timeout, not the second's
    expect(await firstOutcome).toMatch(/superseded|timeout/);

    // The successor is still registered and still completes on its own self-presence.
    expect(p.pendingJoins.size).toBe(1);
    p.onStanza(selfPresence(room, p.nick));
    expect(await secondOutcome).toBe('resolved');
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

    const shortWait = p.armWaiter(room, 100);
    const longWait = p.armWaiter(room, 10_000);
    let longFired: string | undefined;
    void longWait.fired.then((r) => {
      longFired = r;
    });
    expect(p.waiters.get(room)?.size).toBe(2);

    await vi.advanceTimersByTimeAsync(200);
    expect(await shortWait.fired).toBe('timeout');
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
