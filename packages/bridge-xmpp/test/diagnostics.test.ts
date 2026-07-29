import { asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Class: diagnostics discarded on the failure path. A bridge whose stream is flapping, whose
// credentials were revoked, or that was banned from a room must leave a trace an operator can act
// on — and it must go to STDERR, because cli.ts owns stdout as a JSON-RPC channel. Silent handlers
// (`on('error', () => undefined)`) and a swallowed re-join rejection are how a permanently broken
// bridge looks exactly like an idle one.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv } from './fake-xmpp.js';

const CONFIG = { username: 'parley', password: 's3cret-real-pw' };

describe('XMPP failure-path diagnostics', () => {
  afterEach(() => {
    mockState.client = undefined;
    vi.restoreAllMocks();
  });

  it('reports a stream error on stderr (never stdout), rate-limited', async () => {
    const fake = new FakeXmpp();
    mockState.client = fake;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const plugin = new XmppPlugin();
    await plugin.connect(CONFIG);
    fake.emit('error', new Error('stream boom'));
    fake.emit('error', new Error('stream boom again'));

    expect(errors).toHaveBeenCalledTimes(1); // the burst is collapsed, not multiplied
    expect(String(errors.mock.calls[0]?.[0])).toContain('stream boom');
    expect(stdout).not.toHaveBeenCalled();
    await plugin.disconnect();
  });

  it('reports a re-join that fails after a reconnect instead of swallowing it', async () => {
    const fake = new FakeXmpp();
    fake.joinReply = 'error';
    fake.joinErrorCondition = 'forbidden';
    mockState.client = fake;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const plugin = new XmppPlugin();
    await plugin.connect(CONFIG);
    const topic = asTopic('t-diag');
    const room = priv(plugin).roomJid(topic);
    priv(plugin).subscriptions.set(room, { topic, handlers: [() => undefined] });
    priv(plugin).joined.set(room, Promise.resolve());

    fake.emit('online'); // initial connect, consumed by the first-online guard
    fake.emit('online'); // the reconnect: occupancy is gone, the re-join is rejected
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());

    const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('re-join after reconnect failed');
    expect(logged).toContain(room);
    expect(logged).toContain('forbidden'); // the condition, not a flattened 'error'
    await plugin.disconnect();
  });
});
