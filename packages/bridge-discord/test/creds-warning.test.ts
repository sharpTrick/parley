import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordPlugin } from '../src/index.js';

// CLASS: a configurable endpoint that carries a SECRET and accepts a plaintext scheme. Both
// `api_url` and `gateway_url` are taken verbatim, and both put the bot token on the wire — the REST
// one in `Authorization: Bot <token>`, the gateway one in the IDENTIFY payload. A Discord token is
// shared across every bridge instance (this package's own README), so one plaintext hop compromises
// the whole fleet. The axis is (key × host spelling), and the warning must name the key AND the
// origin, because an operator with two endpoints configured cannot act on "something is plaintext".
// It stays a WARNING, not a load error: the in-process fakes and loopback dev proxies are plaintext
// by construction.

afterEach(() => {
  vi.restoreAllMocks();
});

const connectWith = async (config: Record<string, unknown>): Promise<string[]> => {
  const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await new DiscordPlugin().connect({ token: 'a-real-bot-token', ...config });
  return spy.mock.calls.map((c) => String(c[0]));
};

/** Both secret-carrying endpoints, with the plaintext scheme each one accepts. */
const KEYS: Array<{
  key: 'api_url' | 'gateway_url';
  secure: string;
  url: (host: string) => string;
}> = [
  { key: 'api_url', secure: 'https://', url: (host) => `http://${host}/api/v10` },
  { key: 'gateway_url', secure: 'wss://', url: (host) => `ws://${host}` },
];

/**
 * Hosts that LOOK like a loopback spelling without being one, and loopback spellings that look
 * remote. Names of this shape resolve for real (`127.0.0.1.nip.io`), so a prefix or substring match
 * would suppress the warning for a genuinely remote host; where the classification cannot PROVE
 * loopback it warns anyway, because over-warning is the safe side of a credential.
 */
const HOSTS: Array<{ host: string; loopback: boolean }> = [
  { host: '127.0.0.1:8080', loopback: true },
  { host: 'localhost:8080', loopback: true },
  { host: '[::1]:8080', loopback: true },
  { host: '[0:0:0:0:0:0:0:1]', loopback: true },
  { host: '127.0.0.2', loopback: true },
  { host: '127.255.255.254', loopback: true },
  { host: 'discord.example.com', loopback: false },
  { host: '10.0.0.4:8080', loopback: false },
  { host: '127.0.0.1.nip.io', loopback: false },
  { host: 'localhost.evil.com', loopback: false },
  { host: 'notlocalhost', loopback: false },
  { host: '128.0.0.1', loopback: false },
  { host: '[::2]', loopback: false },
  // `new URL` normalizes the IPv4-mapped spelling to this; it is not PROVEN loopback either way.
  { host: '[::ffff:127.0.0.1]', loopback: false },
];

describe('Discord plaintext-credential warning classifies the host, not its spelling', () => {
  for (const { key, url, secure } of KEYS) {
    for (const { host, loopback } of HOSTS) {
      it(`${key} ${url(host)} ${loopback ? 'is loopback and stays silent' : 'warns'}`, async () => {
        const written = await connectWith({ [key]: url(host) });
        const flagged = written.filter((line) => line.includes('plaintext scheme'));
        expect(flagged).toHaveLength(loopback ? 0 : 1);
        if (!loopback) {
          expect(flagged[0]).toContain(`backend_config.${key}`);
          expect(flagged[0]).toContain(new URL(url(host)).origin);
          expect(flagged[0]).toContain(secure);
          expect(flagged[0]).toContain('SECURITY');
        }
      });
    }
  }

  for (const { key, url } of KEYS) {
    it(`${key} over an encrypted scheme is silent`, async () => {
      const encrypted = url('discord.example.com').replace(/^http:/, 'https:').replace(/^ws:/, 'wss:');
      const written = await connectWith({ [key]: encrypted });
      expect(written.filter((line) => line.includes('plaintext scheme'))).toEqual([]);
    });
  }

  it('names BOTH endpoints when both are plaintext and remote', async () => {
    const written = await connectWith({
      api_url: 'http://proxy.internal/api/v10',
      gateway_url: 'ws://proxy.internal',
    });
    const flagged = written.filter((line) => line.includes('plaintext scheme'));
    expect(flagged).toHaveLength(2);
    expect(flagged.join('')).toContain('backend_config.api_url');
    expect(flagged.join('')).toContain('backend_config.gateway_url');
  });

  it('the defaults (Discord itself, no override) are silent', async () => {
    expect((await connectWith({})).filter((l) => l.includes('plaintext scheme'))).toEqual([]);
  });

  it('a warning is one stderr line, so a hostile origin cannot forge a second', async () => {
    const written = await connectWith({ api_url: 'http://proxy.internal/api/v10' });
    const flagged = written.filter((line) => line.includes('plaintext scheme'));
    expect(flagged[0]!.endsWith('\n')).toBe(true);
    expect(flagged[0]!.slice(0, -1)).not.toContain('\n');
  });

  it('warns rather than rejecting, so a plaintext dev proxy still connects', async () => {
    const plugin = new DiscordPlugin();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(
      plugin.connect({ token: 't', api_url: 'http://proxy.internal/api/v10' }),
    ).resolves.toBeUndefined();
    await plugin.disconnect();
  });

  it('is not fooled by a value that is not a URL at all', async () => {
    const written = await connectWith({ api_url: 'not a url', gateway_url: 'also not a url' });
    expect(written.filter((line) => line.includes('plaintext scheme'))).toEqual([]);
  });
});
