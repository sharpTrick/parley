import { asHandle, asTopic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { XmppPlugin } from '../src/index.js';
import { attach, errorEl, expectNoLeaks, FakeXmpp } from './fake-xmpp.js';

// Class: a protocol ERROR response the stanza router silently discards, turning a fast, explained
// failure into a timeout with no cause. A MUC answers `<message type='error'>` when the sender is
// not an occupant, has no voice in a moderated room, was kicked/banned, or the room is gone — the
// reflection can then never arrive, so anything less than an immediate rejection is a 15 s stall
// per post. Presence errors are the same story for joins, and flattening the condition to the
// literal 'error' leaves an operator unable to tell `conflict` from `forbidden` from "room full".
// The table walks realistic conditions on both stanza kinds and demands a prompt, named rejection.

const POST_CONDITIONS = ['not-acceptable', 'forbidden', 'item-not-found', 'gone'];
const JOIN_CONDITIONS = ['conflict', 'registration-required', 'service-unavailable', 'forbidden'];

const TOPIC = asTopic('t-error');

describe('XMPP error stanzas fail the correlated operation promptly, with the condition', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(POST_CONDITIONS)(
    'post() rejects with %s instead of waiting out the reflection timeout',
    async (condition) => {
      vi.useFakeTimers();
      const plugin = new XmppPlugin();
      const fake = new FakeXmpp();
      fake.postReply = 'error';
      fake.postErrorCondition = condition;
      fake.postErrorText = 'server says no';
      const p = attach(plugin, fake);
      p.joined.set(p.roomJid(TOPIC), Promise.resolve());

      const outcome = plugin.post(TOPIC, asHandle('a'), 'hello').then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(50); // long before POST_TIMEOUT_MS

      const message = await outcome;
      expect(message).toContain(condition);
      expect(message).toContain('server says no');
      expect(message).not.toContain('timeout');
      expect(vi.getTimerCount()).toBe(0); // the reflection timer was cleared, not left armed
      expectNoLeaks(plugin);
    },
  );

  it.each(JOIN_CONDITIONS)(
    'a MUC join rejected with %s surfaces that exact condition',
    async (condition) => {
      vi.useFakeTimers();
      const plugin = new XmppPlugin();
      const fake = new FakeXmpp();
      fake.joinReply = 'error';
      fake.joinErrorCondition = condition;
      fake.joinErrorText = 'nope';
      const p = attach(plugin, fake);

      const outcome = p.joinOnce(p.roomJid(TOPIC)).then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(50);

      const message = await outcome;
      expect(message).toContain(condition);
      expect(message).toContain('nope');
      expect(vi.getTimerCount()).toBe(0);
      expectNoLeaks(plugin);
    },
  );

});

// Class: a correlator keyed on the BARE JID while the RESOURCE decides authority. A MUC bounce of
// our own stanza always comes from the bare room JID (RFC 6120 §8.3 puts the `to` we addressed in
// the error's `from`, and this plugin only ever addresses the room), but a co-occupant's
// `<message type='error'>` sent to our occupant JID is routed on by the MUC with
// `from='room/attacker'` — verified against a live Prosody. Correlating on `bareOf(from)` alone
// therefore hands any occupant the power to reject our in-flight joins and posts at will:
// `not-acceptable` is not retryable, so one well-timed stanza kills a join outright, and via
// `subscribe` that failure reaches `startPushLoop`, which takes the bridge process down. The table
// crosses every `from` an error stanza can arrive with against every operation it could correlate
// to, and only the bare-room-JID row may settle anything.

interface Origin {
  name: string;
  /** Only a bounce from the room itself is the SERVICE answering this connection's own stanza. */
  authoritative: boolean;
  from(room: string): string;
}
const origins: Origin[] = [
  { name: 'the bare room JID', authoritative: true, from: (room) => room },
  { name: 'a co-occupant of the room', authoritative: false, from: (room) => `${room}/attacker` },
  { name: 'our own occupant JID in the room', authoritative: false, from: (room) => `${room}/${OUR_NICK}` },
  { name: 'a different room', authoritative: false, from: () => OTHER_ROOM },
  { name: 'an occupant of a different room', authoritative: false, from: () => `${OTHER_ROOM}/x` },
];

interface Operation {
  name: string;
  /** Whether an authoritative bounce is one this operation should answer to at all. */
  correlates: boolean;
  /** The `id` the bounce carries; `undefined` for a bounce with none (a join refusal). */
  id(ownOriginId: string): string | undefined;
  kind: 'post' | 'join';
}
const operations: Operation[] = [
  {
    name: 'a pending post, bounced with its own origin-id',
    kind: 'post',
    correlates: true,
    id: (own) => own,
  },
  {
    name: 'a pending post, bounced with a FOREIGN origin-id',
    kind: 'post',
    correlates: false,
    id: () => 'o-someone-elses-post',
  },
  { name: 'a pending join, bounced with no id', kind: 'join', correlates: true, id: () => undefined },
];

const OTHER_ROOM = 'other-room@muc.parley.local';
const OUR_NICK = 'parley-test';

const cells = operations.flatMap((operation) => origins.map((origin) => ({ operation, origin })));

describe('XMPP error-stanza provenance (only the room bounces this connection\'s stanzas)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(cells)('$operation.name, given an error from $origin.name', async ({ operation, origin }) => {
    vi.useFakeTimers();
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    fake.postReply = 'silent';
    fake.joinReply = 'silent';
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);

    let settled: string | undefined;
    const record = (outcome: string) => (settled = outcome);
    if (operation.kind === 'join') {
      void p.joinOnce(room).then(
        () => record('resolved'),
        (e: Error) => record(e.message),
      );
    } else {
      p.joined.set(room, Promise.resolve());
      void plugin.post(TOPIC, asHandle('a'), 'hello').then(
        () => record('resolved'),
        (e: Error) => record(e.message),
      );
    }
    await vi.advanceTimersByTimeAsync(1);
    const id = operation.id([...p.pendingPosts.keys()][0] ?? 'o-none');

    p.onStanza(
      xml(
        'message',
        { from: origin.from(room), type: 'error', ...(id === undefined ? {} : { id }) },
        errorEl('not-acceptable', 'no voice'),
      ),
    );
    await vi.advanceTimersByTimeAsync(1);

    const shouldSettle = origin.authoritative && operation.correlates;
    expect(settled).toEqual(
      shouldSettle ? expect.stringContaining('not-acceptable') : undefined,
    );

    await plugin.disconnect();
    await vi.advanceTimersByTimeAsync(1);
    expectNoLeaks(plugin);
  });
});
