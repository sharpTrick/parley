import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConfigRisk,
  configRisks,
  CREDENTIAL_CONFIG_KEYS,
  describeRisk,
  resolveConfig,
} from '../src/config.js';
import { ZulipPlugin } from '../src/index.js';

// Zulip must not silently run with the repo-public default API key, nor put a real one on the wire
// in the clear. connect() does no network I/O (auth is per-request HTTP Basic), so both warnings
// are emitted synchronously.
//
// Each risk is graded as the VALUE `configRisks` returns, never as substrings of the sentence built
// from it: a warning reworded to say the bot email and api_key are NOT sent in the clear names every
// word a `toContain` could look for. Of the sentence, only DELIVERY is graded. Break `configRisks` —
// drop a risk, drop a key from `exposes`, name another origin — and this file reds.
afterEach(() => {
  vi.restoreAllMocks();
});

const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

const DEFAULT_KEY_RISK: ConfigRisk = { key: 'api_key', sharedDefault: 'parley-api-key' };
const plaintextRisk = (siteUrl: string): ConfigRisk => ({
  key: 'site_url',
  origin: new URL(siteUrl).origin,
  exposes: [...CREDENTIAL_CONFIG_KEYS],
});

/** Every string a risk is made of, so the line an operator acts on can be held to naming them all. */
const partsOf = (risk: ConfigRisk): string[] =>
  Object.values(risk).flatMap((v: unknown) => (Array.isArray(v) ? v.map(String) : [String(v)]));

/**
 * The operator SAW it: one line on the warning channel, marked as a security finding, naming every
 * part of the risk, and rendered FROM that risk.
 */
const expectDelivered = (lines: readonly string[], risk: ConfigRisk): void => {
  const shown = lines.filter((l) => l.includes(describeRisk(risk)));
  expect(shown, `no warning renders the ${risk.key} risk`).toHaveLength(1);
  expect(shown[0]).toContain('[parley-zulip] SECURITY');
  for (const part of partsOf(risk)) expect(shown[0], `never names ${part}`).toContain(part);
};

/** Connect, and hold the warnings to exactly the risks expected — as values, then as lines. */
const expectRisks = async (config: Record<string, unknown>, expected: ConfigRisk[]): Promise<void> => {
  const warn = spyWarn();
  await new ZulipPlugin().connect(config);
  expect(configRisks(resolveConfig(config))).toEqual(expected);
  const lines = warn.mock.calls.map((c) => String(c[0]));
  expect(lines).toHaveLength(expected.length);
  for (const risk of expected) expectDelivered(lines, risk);
  warn.mockRestore();
};

describe('Zulip default-credential warning', () => {
  it('warns once, naming the backend and the key to set, when api_key is omitted', async () => {
    await expectRisks({ site_url: 'http://127.0.0.1:9991' }, [DEFAULT_KEY_RISK]);
  });

  it('warns when api_key is set literally to the well-known default', async () => {
    await expectRisks({ api_key: 'parley-api-key', email: 'bot@example.com' }, [DEFAULT_KEY_RISK]);
  });

  it('does NOT warn when a real api_key is supplied over loopback', async () => {
    await expectRisks(
      { site_url: 'http://127.0.0.1:9991', api_key: 's3cret-real-key', email: 'bot@example.com' },
      [],
    );
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
      const siteUrl = `http://${host}:9991`;
      await expectRisks(
        { site_url: siteUrl, email: 'bot@example.com', api_key: 's3cret-real-key' },
        loopback ? [] : [plaintextRisk(siteUrl)],
      );
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
        const risks = [
          ...(key.defaultKey ? [DEFAULT_KEY_RISK] : []),
          ...(transport.plaintextRemote ? [plaintextRisk(transport.site_url)] : []),
        ];
        expect(risks).toHaveLength(expected);
        await expectRisks(
          {
            site_url: transport.site_url,
            email: 'bot@example.com',
            ...(key.api_key === undefined ? {} : { api_key: key.api_key }),
          },
          risks,
        );
      });
    }
  }
});
