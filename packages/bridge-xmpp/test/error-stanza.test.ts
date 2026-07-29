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

  it('a bounced message error for a room with a pending join fails that join too', async () => {
    vi.useFakeTimers();
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    fake.joinReply = 'silent';
    const p = attach(plugin, fake);
    const room = p.roomJid(TOPIC);

    const outcome = p.joinOnce(room).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    p.onStanza(xml('message', { from: room, type: 'error' }, errorEl('forbidden')));
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toContain('forbidden');
    expect(vi.getTimerCount()).toBe(0);
    expectNoLeaks(plugin);
  });

  it('an error stanza for a DIFFERENT room settles nothing (provenance is checked first)', async () => {
    vi.useFakeTimers();
    const plugin = new XmppPlugin();
    const fake = new FakeXmpp();
    fake.postReply = 'silent';
    const p = attach(plugin, fake);
    p.joined.set(p.roomJid(TOPIC), Promise.resolve());

    let settled = false;
    void plugin.post(TOPIC, asHandle('a'), 'hello').then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(1);
    const originId = [...p.pendingPosts.keys()][0]!;

    p.onStanza(
      xml(
        'message',
        { from: 'other-room@muc.parley.local', type: 'error', id: originId },
        errorEl('forbidden'),
      ),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    expect(p.pendingPosts.size).toBe(1);

    await plugin.disconnect();
    expectNoLeaks(plugin);
  });
});
