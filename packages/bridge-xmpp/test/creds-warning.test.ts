import { afterEach, describe, expect, it, vi } from 'vitest';

// Class: a credential this backend puts on the network with no diagnostic. Two independent ways
// that happens here — the repo-public default password, and a plaintext `service` scheme to a
// non-loopback host, where @xmpp/starttls only upgrades a stream the PEER offers to upgrade while
// @xmpp/client always registers SASL PLAIN. Neither is refused (a loopback dev server legitimately
// runs unencrypted, and the README's own Prosody snippet sets allow_unencrypted_plain_auth), so the
// contract is that no cell is SILENT: the transport table below crosses every scheme this library
// accepts with every host class and both password kinds, and asserts exactly which cells warn.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { isPlaintextRemote, XmppPlugin } from '../src/index.js';
import { FakeXmpp } from './fake-xmpp.js';

afterEach(() => {
  vi.restoreAllMocks();
  mockState.client = undefined;
});

const spyWarn = (): ReturnType<typeof vi.spyOn> =>
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

const connect = async (config: Record<string, unknown>): Promise<string[]> => {
  const warn = spyWarn();
  mockState.client = new FakeXmpp();
  const plugin = new XmppPlugin();
  await plugin.connect(config);
  await plugin.disconnect();
  return warn.mock.calls.map((c) => String(c[0]));
};

describe('XMPP default-credential warning', () => {
  it('warns once, naming the backend and the key to set, when password is omitted', async () => {
    const warned = await connect({ service: 'xmpp://127.0.0.1:5222', username: 'parley' });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('parley-xmpp');
    expect(warned[0]).toContain('password');
  });

  it('warns when password is set literally to the well-known default', async () => {
    expect(await connect({ password: 'parleypass' })).toHaveLength(1);
  });

  it('does NOT warn when a real password is supplied to a loopback service', async () => {
    expect(await connect({ password: 's3cret-real-pw', username: 'parley' })).toEqual([]);
  });
});

// The transport half. `schemes` is pinned by VALUE as well as driven into the table: a scheme
// dropped from the plaintext set would otherwise silently delete its own rows.
const PLAINTEXT = ['xmpp://', 'ws://'];
const ENCRYPTED = ['xmpps://', 'wss://'];
const LOOPBACK = ['127.0.0.1:5222', 'localhost:5222', '[::1]:5222', '::1', '127.0.0.44'];
const REMOTE = ['xmpp.example.com:5222', 'xmpp.example.com', '203.0.113.9:5222', '[2001:db8::1]:5222'];

interface Cell {
  service: string;
  password: string | undefined;
  /** How many warnings this configuration must produce: the credential one, the transport one. */
  expected: { credential: boolean; transport: boolean };
}

const cells: Cell[] = [];
for (const [schemes, plaintext] of [
  [PLAINTEXT, true],
  [ENCRYPTED, false],
] as const) {
  for (const scheme of schemes) {
    for (const [hosts, loopback] of [
      [LOOPBACK, true],
      [REMOTE, false],
    ] as const) {
      for (const host of hosts) {
        for (const password of ['a-real-secret', undefined]) {
          cells.push({
            service: `${scheme}${host}`,
            password,
            expected: { credential: password === undefined, transport: plaintext && !loopback },
          });
        }
      }
    }
  }
}

describe('XMPP transport safety', () => {
  it('the plaintext scheme set is exactly xmpp:// and ws://', () => {
    for (const scheme of PLAINTEXT) expect(isPlaintextRemote(`${scheme}remote.example`)).toBe(true);
    for (const scheme of ENCRYPTED) expect(isPlaintextRemote(`${scheme}remote.example`)).toBe(false);
  });

  it.each(cells)('$service (password $password) warns as documented', async (cell) => {
    const warned = await connect({
      service: cell.service,
      ...(cell.password === undefined ? {} : { password: cell.password }),
    });
    const credential = warned.filter((m) => m.includes('default password'));
    const transport = warned.filter((m) => m.includes('plaintext scheme'));
    expect(credential).toHaveLength(cell.expected.credential ? 1 : 0);
    expect(transport).toHaveLength(cell.expected.transport ? 1 : 0);
    // Nothing else was reported, so a cell that must warn cannot be riding another's line.
    expect(warned).toHaveLength(credential.length + transport.length);
    expect(warned.every((m) => m.includes('parley-xmpp'))).toBe(true);
  });
});
