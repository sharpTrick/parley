import { asHandle, asTopic } from '@sharptrick/parley-core';
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

// Class: a fallback that degrades a documented durability property without a signal. A room this
// plugin creates is configured PERSISTENT because a non-persistent MUC and its entire MAM archive
// are destroyed when the last occupant leaves — which every stream drop causes — so a service that
// refuses the field silently converts "history survives a reconnect" into "catch-up returns an empty
// page after the next blip". The join resolves either way, so nothing downstream can tell; the only
// place the operator can learn it is stderr. The table walks every way the config submit can fail,
// with the accepting service as the negative control so a green row is not a dead assertion.

interface DurabilityRow {
  name: string;
  ownerConfig: FakeXmpp['ownerConfig'];
  /** How many stderr lines the room earns: one per submit that failed. */
  lines: number;
  /** Phrases the operator needs: what was refused, and what it costs them. */
  reports: RegExp[];
}
const durabilityRows: DurabilityRow[] = [
  {
    name: 'the persistent-room submit is refused',
    ownerConfig: 'refuses-persistent',
    lines: 1,
    reports: [/NON-PERSISTENT/, /destroyed when the last occupant leaves/],
  },
  {
    name: 'the bare instant-room fallback is refused too',
    ownerConfig: 'refuses-everything',
    lines: 2,
    reports: [/NON-PERSISTENT/, /stays LOCKED/],
  },
  {
    name: 'the owner IQ is never answered',
    ownerConfig: 'times-out',
    lines: 2,
    reports: [/NON-PERSISTENT/, /stays LOCKED/],
  },
  { name: 'the service accepts it (negative control)', ownerConfig: 'accepts', lines: 0, reports: [] },
];

describe('XMPP reports a room it could not make durable', () => {
  it.each(durabilityRows)('$name', async (row) => {
    const fake = new FakeXmpp();
    fake.announceCreation = true; // status 201: this join CREATED the room, so it configures it
    fake.ownerConfig = row.ownerConfig;
    mockState.client = fake;
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m) => {
      errors.push(String(m));
    });

    const plugin = new XmppPlugin();
    await plugin.connect(CONFIG);
    const topic = asTopic(`t-durable-${row.ownerConfig}`);
    const room = priv(plugin).roomJid(topic);
    try {
      // The join still succeeds — the point is that it stops being SILENT, not that it starts failing.
      await expect(plugin.post(topic, asHandle('a'), 'hello')).resolves.toBeDefined();
      const durability = errors.filter((m) => m.includes(room));
      expect(durability).toHaveLength(row.lines);
      for (const phrase of row.reports) expect(durability.join('\n')).toMatch(phrase);
    } finally {
      await plugin.disconnect();
    }
  });
});
