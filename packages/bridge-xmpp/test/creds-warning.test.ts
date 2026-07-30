import { afterEach, describe, expect, it, vi } from 'vitest';

// Class: a credential this backend puts on the network with no diagnostic. Two independent ways
// that happens here — the repo-public default password, and a `service` that can terminate on a
// cleartext socket at a non-loopback host, where @xmpp/starttls only upgrades a stream the PEER
// offers to upgrade while @xmpp/client always registers SASL PLAIN. Neither is refused (a loopback
// dev server legitimately runs unencrypted, and the README's own Prosody snippet sets
// allow_unencrypted_plain_auth), so the contract is that no cell is SILENT.
//
// The transport table crosses the URI FORM with the host class and both password kinds. Form is
// its own axis because the guard used to key on the scheme alone: a service with no scheme — the
// standard DNS-SRV form — matched nothing in the plaintext set and went silent, while
// @xmpp/resolve routes exactly that form through SRV and falls back to cleartext xmpp://…:5222.
// Only an explicitly encrypted scheme is safe; every other form is a way to reach a plain socket.

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

// The transport half. `forms` is pinned by VALUE as well as driven into the table: a form dropped
// from it would otherwise silently delete its own rows.
interface Form {
  name: string;
  service(host: string): string;
  /** Whether this form's stream is encrypted before SASL runs — the only reason to stay silent. */
  encrypted: boolean;
}
const forms: Form[] = [
  { name: 'xmpp://', service: (h) => `xmpp://${h}`, encrypted: false },
  { name: 'ws://', service: (h) => `ws://${h}`, encrypted: false },
  { name: 'xmpps://', service: (h) => `xmpps://${h}`, encrypted: true },
  { name: 'wss://', service: (h) => `wss://${h}`, encrypted: true },
  { name: 'no scheme (DNS-SRV)', service: (h) => h, encrypted: false },
  { name: 'scheme-relative', service: (h) => `//${h}`, encrypted: false },
];
const LOOPBACK = ['127.0.0.1:5222', 'localhost:5222', '[::1]:5222', '::1', '127.0.0.44'];
// Hosts that read as loopback to a PREFIX or substring match but are ordinary registrable names
// their owner points wherever they like, plus two integer spellings of 127.0.0.1 that are not
// dotted quads. Every LOOPBACK entry is also probed with a domain suffixed onto it, so a loopback
// form added above brings its own lookalike with it instead of waiting to be enumerated.
const LOOKALIKE = [
  ...LOOPBACK.map((host) => `${host}.evil.example`),
  '127.evil.com',
  '127.0.0.1.evil.com',
  'localhost.evil.com',
  '0177.0.0.1',
  '2130706433',
];
const REMOTE = [
  'xmpp.example.com:5222',
  'xmpp.example.com',
  '203.0.113.9:5222',
  '[2001:db8::1]:5222',
  ...LOOKALIKE,
];

interface Cell {
  service: string;
  password: string | undefined;
  /** How many warnings this configuration must produce: the credential one, the transport one. */
  expected: { credential: boolean; transport: boolean };
}

const cells: Cell[] = [];
for (const form of forms) {
  for (const [hosts, loopback] of [
    [LOOPBACK, true],
    [REMOTE, false],
  ] as const) {
    for (const host of hosts) {
      for (const password of ['a-real-secret', undefined]) {
        cells.push({
          service: form.service(host),
          password,
          expected: {
            credential: password === undefined,
            transport: !form.encrypted && !loopback,
          },
        });
      }
    }
  }
}

describe('XMPP transport safety', () => {
  it('only an explicitly encrypted scheme is classified safe', () => {
    for (const form of forms) {
      expect(isPlaintextRemote(form.service('remote.example'))).toBe(!form.encrypted);
    }
  });

  it.each(LOOKALIKE)('%s is classified remote, not loopback', (host) => {
    for (const form of forms.filter((f) => !f.encrypted)) {
      expect(isPlaintextRemote(form.service(host))).toBe(true);
    }
  });

  it.each(cells)('$service (password $password) warns as documented', async (cell) => {
    const warned = await connect({
      service: cell.service,
      ...(cell.password === undefined ? {} : { password: cell.password }),
    });
    const credential = warned.filter((m) => m.includes('default password'));
    const transport = warned.filter((m) => m.includes('in the clear'));
    expect(credential).toHaveLength(cell.expected.credential ? 1 : 0);
    expect(transport).toHaveLength(cell.expected.transport ? 1 : 0);
    // Nothing else was reported, so a cell that must warn cannot be riding another's line.
    expect(warned).toHaveLength(credential.length + transport.length);
    expect(warned.every((m) => m.includes('parley-xmpp'))).toBe(true);
  });
});
