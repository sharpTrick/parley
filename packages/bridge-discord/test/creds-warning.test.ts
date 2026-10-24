import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscordBackendConfig } from '../src/config.js';
import { type ConfigRisk, configRisks, describeRisk } from '../src/creds.js';
import { DiscordPlugin } from '../src/index.js';

// CLASS: a configurable endpoint that carries a SECRET and accepts a plaintext scheme. Both
// `api_url` and `gateway_url` are taken verbatim, and both put the bot token on the wire — the REST
// one in `Authorization: Bot <token>`, the gateway one in the IDENTIFY payload. A Discord token is
// shared across every bridge instance (this package's own README), so one plaintext hop compromises
// the whole fleet. The axis is (key × host spelling), and the warning must name the key AND the
// origin, because an operator with two endpoints configured cannot act on "something is plaintext".
// It stays a WARNING, not a load error: the in-process fakes and loopback dev proxies are plaintext
// by construction.
//
// Each risk is graded as the VALUE `configRisks` returns — key, origin, the secret exposed, the
// scheme to use — never as words of the sentence: a warning reworded to say nobody on the path can
// take the token still names the key, the origin and `wss://`. Of the sentence, only DELIVERY is
// graded: one SECURITY line, rendered from that risk, naming every part of it.

afterEach(() => {
  vi.restoreAllMocks();
});

const connectWith = async (config: Record<string, unknown>): Promise<string[]> => {
  const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await new DiscordPlugin().connect({ token: 'a-real-bot-token', ...config });
  return spy.mock.calls.map((c) => String(c[0]));
};

const security = (lines: readonly string[]): string[] => lines.filter((l) => l.includes('SECURITY'));

/** Connect, and hold the warnings to exactly the risks expected — as values, then as lines. */
const expectRisks = async (config: Record<string, unknown>, expected: ConfigRisk[]): Promise<void> => {
  const written = security(await connectWith(config));
  expect(configRisks({ token: 'a-real-bot-token', ...config } as DiscordBackendConfig)).toEqual(
    expected,
  );
  expect(written).toHaveLength(expected.length);
  for (const risk of expected) {
    const shown = written.filter((l) => l.includes(describeRisk(risk)));
    expect(shown, `no warning renders the ${risk.key} risk`).toHaveLength(1);
    expect(shown[0]).toContain('parley-discord: SECURITY');
    for (const part of [risk.key, risk.origin, risk.secure, ...risk.exposes]) {
      expect(shown[0], `never names ${part}`).toContain(part);
    }
  }
};

const riskOf = (key: ConfigRisk['key'], url: string, secure: string): ConfigRisk => ({
  key,
  origin: new URL(url).origin,
  exposes: ['token'],
  secure,
});

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
        await expectRisks({ [key]: url(host) }, loopback ? [] : [riskOf(key, url(host), secure)]);
      });
    }
  }

  for (const { key, url } of KEYS) {
    it(`${key} over an encrypted scheme is silent`, async () => {
      const encrypted = url('discord.example.com').replace(/^http:/, 'https:').replace(/^ws:/, 'wss:');
      await expectRisks({ [key]: encrypted }, []);
    });
  }

  it('names BOTH endpoints when both are plaintext and remote', async () => {
    await expectRisks({ api_url: 'http://proxy.internal/api/v10', gateway_url: 'ws://proxy.internal' }, [
      riskOf('api_url', 'http://proxy.internal/api/v10', 'https://'),
      riskOf('gateway_url', 'ws://proxy.internal', 'wss://'),
    ]);
  });

  it('the defaults (Discord itself, no override) are silent', async () => {
    await expectRisks({}, []);
  });

  it('a warning is one stderr line, so a hostile origin cannot forge a second', async () => {
    const flagged = security(await connectWith({ api_url: 'http://proxy.internal/api/v10' }));
    expect(flagged).toHaveLength(1);
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
    await expectRisks({ api_url: 'not a url', gateway_url: 'also not a url' }, []);
  });
});
