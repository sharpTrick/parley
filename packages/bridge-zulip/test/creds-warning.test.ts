import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZulipPlugin } from '../src/index.js';

// SEC-06 — Zulip must not silently run with the repo-public default API key, nor put a real one on
// the wire in the clear. connect() does no network I/O (auth is per-request HTTP Basic), so both
// warnings are emitted synchronously.
afterEach(() => {
  vi.restoreAllMocks();
});

const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

describe('Zulip default-credential warning (SEC-06)', () => {
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

describe('Zulip credential-transport warning (SEC-06)', () => {
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
