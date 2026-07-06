import { afterEach, describe, expect, it, vi } from 'vitest';
import { XmppPlugin } from '../src/index.js';

// SEC-06 — XMPP must not silently authenticate with the repo-public default password. connect()
// performs a SASL handshake via @xmpp/client, so mock the client to a no-op transport (vi.mock is
// hoisted above the import above, so the plugin binds the mock); the warning fires before
// client()/xmpp.start(). The mock lets the whole connect() resolve so the gate sits on the happy path.
vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => ({
    on: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

describe('XMPP default-credential warning (SEC-06)', () => {
  it('warns once, naming the backend and the key to set, when password is omitted', async () => {
    const warn = spyWarn();
    await new XmppPlugin().connect({ service: 'xmpp://127.0.0.1:5222', username: 'parley' });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('parley-xmpp');
    expect(msg).toContain('password');
  });

  it('warns when password is set literally to the well-known default', async () => {
    const warn = spyWarn();
    await new XmppPlugin().connect({ password: 'parleypass' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn when a real password is supplied', async () => {
    const warn = spyWarn();
    await new XmppPlugin().connect({ password: 's3cret-real-pw', username: 'parley' });
    expect(warn).not.toHaveBeenCalled();
  });
});
