import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZulipPlugin } from '../src/index.js';

// Zulip must not silently run with the repo-public default API key, nor put a real one on the wire
// in the clear. connect() does no network I/O (auth is per-request HTTP Basic), so both warnings
// are emitted synchronously.
afterEach(() => {
  vi.restoreAllMocks();
});

const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

describe('Zulip default-credential warning', () => {
  it('warns once, naming the backend and the key to set, when api_key is omitted', async () => {
    const warn = spyWarn();
    await new ZulipPlugin().connect({ site_url: 'http://127.0.0.1:9991' });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('parley-zulip');
    expect(msg).toContain('api_key');
  });

  it('warns when api_key is set literally to the well-known default', async () => {
    const warn = spyWarn();
    await new ZulipPlugin().connect({ api_key: 'parley-api-key', email: 'bot@example.com' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn when a real api_key is supplied over loopback', async () => {
    const warn = spyWarn();
    await new ZulipPlugin().connect({
      site_url: 'http://127.0.0.1:9991',
      api_key: 's3cret-real-key',
      email: 'bot@example.com',
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

/** Every transport a credential can travel over, and whether it must be flagged. */
const TRANSPORTS = [
  { site_url: 'http://127.0.0.1:9991', plaintextRemote: false },
  { site_url: 'http://localhost:9991', plaintextRemote: false },
  { site_url: 'http://[::1]:9991', plaintextRemote: false },
  { site_url: 'http://zulip.example.com', plaintextRemote: true },
  { site_url: 'http://10.0.0.4:9991', plaintextRemote: true },
  { site_url: 'https://zulip.example.com', plaintextRemote: false },
];
const KEYS = [
  { api_key: undefined, defaultKey: true },
  { api_key: 'parley-api-key', defaultKey: true },
  { api_key: 's3cret-real-key', defaultKey: false },
];

/**
 * Hosts that LOOK like the loopback spellings above without being them, and loopback spellings that
 * look remote. The classification decides whether the operator is told their bot `email:api_key` is
 * crossing the network in the clear, and names of this shape resolve for real (`127.0.0.1.nip.io`),
 * so a prefix or substring match on the hostname suppresses the warning for a genuinely remote host.
 * Anything that is not exactly `localhost` or a literal loopback address must be warned about; where
 * the classification cannot prove loopback it warns anyway, because over-warning is the safe side.
 */
const NEAR_MISSES = [
  { host: '127.0.0.1.evil.com', loopback: false },
  { host: '127.0.0.1.nip.io', loopback: false },
  { host: 'localhost.evil.com', loopback: false },
  { host: 'notlocalhost', loopback: false },
  { host: 'localhost-1', loopback: false },
  { host: '128.0.0.1', loopback: false },
  { host: '27.0.0.1', loopback: false },
  { host: '[::2]', loopback: false },
  // `new URL` normalizes the IPv4-mapped spelling to this, and it is not proven loopback either way.
  { host: '[::ffff:127.0.0.1]', loopback: false },
  { host: '127.0.0.2', loopback: true },
  { host: '127.255.255.254', loopback: true },
  { host: '[0:0:0:0:0:0:0:1]', loopback: true },
];

/** Shapes that are not a usable base URL at all — `connect` must reject them, not classify them. */
const UNUSABLE_HOSTS = ['my127.0.0.1', '1270.0.0.1', '127.0.0.256'];

describe('Zulip plaintext-credential warning classifies the host, not its spelling', () => {
  for (const { host, loopback } of NEAR_MISSES) {
    it(`http://${host} is ${loopback ? 'loopback' : 'remote'}`, async () => {
      const warn = spyWarn();
      await new ZulipPlugin().connect({
        site_url: `http://${host}:9991`,
        email: 'bot@example.com',
        api_key: 's3cret-real-key',
      });
      const all = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(all.includes('plaintext http://')).toBe(!loopback);
      expect(warn).toHaveBeenCalledTimes(loopback ? 0 : 1);
    });
  }

  for (const host of UNUSABLE_HOSTS) {
    it(`http://${host} is rejected as an unusable site_url`, async () => {
      await expect(
        new ZulipPlugin().connect({ site_url: `http://${host}:9991`, email: 'bot@example.com' }),
      ).rejects.toThrow('site_url');
    });
  }

  /** The shape of the whole class: a NAME is never loopback, however it is spelled, bar `localhost`. */
  it('warns for every hostname that is a name rather than an address', async () => {
    const hosts = ['zulip', 'localhost', '127', 'l0calhost', 'xn--80ak6aa92e'].flatMap((label) =>
      ['.example.com', '.internal', ''].map((suffix) => `${label}${suffix}`),
    );
    for (const host of hosts) {
      const warn = spyWarn();
      await new ZulipPlugin().connect({
        site_url: `http://${host}`,
        email: 'bot@example.com',
        api_key: 's3cret-real-key',
      });
      expect(warn, host).toHaveBeenCalledTimes(host === 'localhost' ? 0 : 1);
      warn.mockRestore();
    }
  });
});

describe('Zulip credential-transport warning', () => {
  for (const transport of TRANSPORTS) {
    for (const key of KEYS) {
      const expected = Number(transport.plaintextRemote) + Number(key.defaultKey);
      it(`emits ${expected} warning(s) for ${transport.site_url} with ${key.api_key ?? 'no'} key`, async () => {
        const warn = spyWarn();
        await new ZulipPlugin().connect({
          site_url: transport.site_url,
          email: 'bot@example.com',
          ...(key.api_key === undefined ? {} : { api_key: key.api_key }),
        });
        expect(warn).toHaveBeenCalledTimes(expected);
        const all = warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(all.includes('plaintext http://')).toBe(transport.plaintextRemote);
        expect(all.includes('built-in default API key')).toBe(key.defaultKey);
      });
    }
  }
});
