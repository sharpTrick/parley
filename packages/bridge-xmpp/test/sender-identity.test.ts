import { asHandle, asTopic, type Handle } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';

// Class: a `senderHandle` that is a per-CONNECTION token rather than the bridge's logical identity.
// DESIGN §5 defines senderHandle as the logical sender, and core keys the parley_list_users roster
// (computeRoster, engine/presence.ts) on exactly that field — the presence record body carries no
// handle of its own. A backend whose sender is regenerated per process therefore reports a handle
// nobody can hand work off to, AND accumulates one phantom roster entry per restart for the whole
// since_ms window. The table crosses every way this bridge comes back (a fresh process on the same
// config, a stream reconnect) with every way its occupant identity can be configured, and demands
// of each that the archive attributes both beats to ONE handle, and that the handle is the
// configured identity rather than a token.

// Keep the real client reachable when no fake is installed, so that the live row below (and the
// reachability probe that gates it) still talks to a real server from this same file.
const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return {
    ...actual,
    client: (opts: Parameters<typeof actual.client>[0]) => mockState.client ?? actual.client(opts),
  };
});

import { XmppPlugin, type XmppBackendConfig } from '../src/index.js';
import { FakeXmpp } from './fake-xmpp.js';
import { BASE, canAuth, freshTopic } from './live-xmpp.js';

const TOPIC = asTopic('t-identity');
const IDENTITY: Handle = asHandle('ctx-payments');
const PASSWORD = 'a-real-secret';

type Restart = 'a fresh process on the same config' | 'a stream reconnect';

interface Row {
  restart: Restart;
  config: string;
  cfg: Partial<XmppBackendConfig>;
  expected: string;
}

const configs: Array<{ config: string; cfg: Partial<XmppBackendConfig>; expected: string }> = [
  { config: 'nick unset (taken from identity)', cfg: {}, expected: String(IDENTITY) },
  { config: 'nick pinned', cfg: { nick: 'pinned-session' }, expected: 'pinned-session' },
];
const restarts: Restart[] = ['a fresh process on the same config', 'a stream reconnect'];
const rows: Row[] = restarts.flatMap((restart) => configs.map((c) => ({ restart, ...c })));

const beats = async (row: Row): Promise<string[]> => {
  const fake = new FakeXmpp();
  mockState.client = fake;
  const first = new XmppPlugin();
  await first.connect({ password: PASSWORD, ...row.cfg });
  await first.post(TOPIC, IDENTITY, 'beat-1');

  let reader = first;
  if (row.restart === 'a stream reconnect') {
    fake.emit('online'); // the initial connect, consumed by the first-online guard
    fake.emit('online'); // the reconnect
    await vi.waitFor(() => expect(fake.sent.filter((s) => s.is('presence')).length).toBe(2));
  } else {
    await first.disconnect();
    reader = new XmppPlugin();
    await reader.connect({ password: PASSWORD, ...row.cfg });
  }
  await reader.post(TOPIC, IDENTITY, 'beat-2');

  const read = await reader.fetchRecent({ topic: TOPIC, limit: 10 });
  expect(read.messages.map((m) => m.content)).toEqual(['beat-1', 'beat-2']);
  const handles = read.messages.map((m) => String(m.senderHandle));
  await reader.disconnect();
  return handles;
};

describe('XMPP attributes a bridge to one stable handle across a restart', () => {
  it.each(rows)('$restart, $config', async (row) => {
    const handles = await beats(row);
    // One roster entry, not one per process — and the entry an operator can address.
    expect(new Set(handles).size).toBe(1);
    expect(handles[0]).toBe(row.expected);
  });
});

const serverUp = await canAuth(BASE);

describe.skipIf(!serverUp)('XMPP sender identity against a real MUC archive', () => {
  it('two runs of the same config archive under one handle, and it is identity.handle', async () => {
    mockState.client = undefined;
    const topic = freshTopic('ident');
    const first = new XmppPlugin();
    await first.connect(BASE);
    await first.post(topic, IDENTITY, 'beat-1');
    await first.disconnect();

    const second = new XmppPlugin();
    await second.connect(BASE);
    try {
      await second.post(topic, IDENTITY, 'beat-2');
      const read = await second.fetchRecent({ topic, limit: 10 });
      expect(read.messages.map((m) => m.content)).toEqual(['beat-1', 'beat-2']);
      const handles = read.messages.map((m) => String(m.senderHandle));
      expect(new Set(handles)).toEqual(new Set([String(IDENTITY)]));
    } finally {
      await second.disconnect();
    }
  }, 30_000);
});
