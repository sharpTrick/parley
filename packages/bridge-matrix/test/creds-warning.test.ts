import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConfigRisk,
  configRisks,
  DEFAULT_PASSWORD,
  describeRisk,
  type MatrixBackendConfig,
  SECRET_CONFIG_KEYS,
} from '../src/config.js';
import { MatrixPlugin } from '../src/index.js';
import { TOPIC_KEY } from '../src/wire.js';

/**
 * CLASS: a security posture that exists only in prose. Every config key that widens this backend's
 * trust boundary announces itself on the operator's stderr, because a README paragraph is invisible
 * to whoever copied a fixture config into production — and the repo's own conformance fixture is
 * exactly such a config.
 *
 * Each risk is graded as the VALUE `configRisks` returns, never as substrings of the sentence built
 * from it: an inverted warning — "backend_config.homeserver_url http://… is fine as configured; the
 * m.login.password POST does not put backend_config.password on the network" — names every part of
 * the risk, so no `toContain` over those names can tell it from the truth. Of the SENTENCE, only
 * DELIVERY is graded: the operator is shown a SECURITY-marked line that renders THAT risk.
 *
 * Precondition the fixture depends on: connect() does live I/O (the m.login.password POST), so
 * fetch is stubbed with a valid login. Every warning fires before it and the whole connect() must
 * still RESOLVE, so the gate sits on the happy path rather than on an incidental network failure.
 *
 * Break `configRisks` and this file reds: drop a risk, drop a key from `exposes`, compute a risk
 * and never warn it, or classify a loopback fixture as one.
 */

const okLogin = (): Response =>
  new Response(JSON.stringify({ access_token: 't', user_id: '@parley:parley.local' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A config with every trust-widening knob at its safe setting. */
const SAFE: Record<string, unknown> = {
  homeserver_url: 'http://127.0.0.1:8008',
  user: 'parley',
  password: 's3cret-real-pw',
};

const REMOTE_PLAINTEXT = 'http://matrix.example.org:8008';

const RISKS = {
  'the built-in default password': {
    apply: (c: Record<string, unknown>) => ({ ...c, password: undefined }),
    risk: { key: 'password', sharedDefault: DEFAULT_PASSWORD },
  },
  'shared_room': {
    apply: (c: Record<string, unknown>) => ({ ...c, shared_room: 'parley_all' }),
    risk: { key: 'shared_room', room: 'parley_all', isolatedOnlyBy: TOPIC_KEY },
  },
  'room_preset public_chat': {
    apply: (c: Record<string, unknown>) => ({ ...c, room_preset: 'public_chat' }),
    risk: { key: 'room_preset', preset: 'public_chat' },
  },
  'a plaintext homeserver_url': {
    apply: (c: Record<string, unknown>) => ({ ...c, homeserver_url: REMOTE_PLAINTEXT }),
    risk: {
      key: 'homeserver_url',
      plaintextOrigin: new URL(REMOTE_PLAINTEXT).origin,
      exposes: [...SECRET_CONFIG_KEYS],
    },
  },
} satisfies Record<
  string,
  { apply: (c: Record<string, unknown>) => Record<string, unknown>; risk: ConfigRisk }
>;

type RiskName = keyof typeof RISKS;
const RISK_NAMES = Object.keys(RISKS) as RiskName[];

/** Every string a risk is made of, so the line an operator acts on can be held to naming them all. */
const partsOf = (risk: ConfigRisk): string[] =>
  Object.values(risk).flatMap((v: unknown) => (Array.isArray(v) ? v.map(String) : [String(v)]));

const byKey = (risks: readonly ConfigRisk[]): ConfigRisk[] =>
  [...risks].sort((a, b) => a.key.localeCompare(b.key));

/**
 * The operator SAW it: on the channel a warning goes to, marked as a security finding, naming every
 * part of the risk, and rendered FROM that risk — so a line cannot come to describe a different
 * config from the one it names.
 */
const expectDelivered = (lines: readonly string[], risk: ConfigRisk): void => {
  const parts = partsOf(risk);
  expect(parts.length, `the ${risk.key} risk has no parts, so naming them all grades nothing`)
    .toBeGreaterThan(0);
  const shown = lines.filter((l) => l.includes(describeRisk(risk)));
  expect(shown, `no warning renders the ${risk.key} risk`).toHaveLength(1);
  expect(shown[0]).toContain('[parley-matrix]');
  expect(shown[0]).toContain('SECURITY');
  for (const part of parts) {
    expect(shown[0], `the ${risk.key} warning never names ${part}`).toContain(part);
  }
};

/** Every subset of the risky knobs, so a combination nobody tried is still graded. */
const SUBSETS: RiskName[][] = Array.from({ length: 1 << RISK_NAMES.length }, (_, mask) =>
  RISK_NAMES.filter((_n, i) => (mask & (1 << i)) !== 0),
);

describe('connect warns once per active trust-widening config knob', () => {
  for (const active of SUBSETS) {
    it(`${active.length === 0 ? 'a fully safe config' : active.join(' + ')}: ${active.length} warning(s)`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => okLogin()));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const config = active.reduce<Record<string, unknown>>((c, n) => RISKS[n].apply(c), SAFE);

      await new MatrixPlugin().connect(config);

      const expected = RISK_NAMES.filter((n) => active.includes(n)).map((n) => RISKS[n].risk);
      expect(byKey(configRisks(config as MatrixBackendConfig))).toEqual(byKey(expected));

      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toHaveLength(expected.length);
      for (const risk of expected) expectDelivered(lines, risk);
    });
  }
});

/**
 * The plaintext row above proves the risk is RAISED; this table proves it is decided by what the
 * host IS rather than by how it is spelled. A classifier that string-matches `127.0.0.1` excuses
 * `127.0.0.1.example.com` — a name anyone can resolve wherever they like — and one that only checks
 * the scheme warns about every loopback fixture until the operator stops reading the warnings.
 */
const ORIGINS: Record<string, boolean> = {
  'http://127.0.0.1:8008': false,
  'http://127.9.9.9:8008': false,
  'http://[::1]:8008': false,
  'http://[0:0:0:0:0:0:0:1]:8008': false,
  'http://localhost:8008': false,
  'https://127.0.0.1:8008': false,
  'https://matrix.example.org': false,
  'http://matrix.example.org': true,
  'http://10.0.0.5:8008': true,
  'http://127.0.0.1.example.com': true,
  'http://localhost.example.com': true,
  'http://[::ffff:127.0.0.1]:8008': true,
};

describe('the plaintext-credential risk is decided by the host, not by its spelling', () => {
  for (const [homeserverUrl, warns] of Object.entries(ORIGINS)) {
    it(`${homeserverUrl}: ${warns ? 'warns' : 'silent'}`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => okLogin()));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const config = { ...SAFE, homeserver_url: homeserverUrl };

      await new MatrixPlugin().connect(config);

      const expected: ConfigRisk[] = warns
        ? [
            {
              key: 'homeserver_url',
              plaintextOrigin: new URL(homeserverUrl).origin,
              exposes: [...SECRET_CONFIG_KEYS],
            },
          ]
        : [];
      expect(configRisks(config as MatrixBackendConfig)).toEqual(expected);

      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toHaveLength(expected.length);
      for (const risk of expected) expectDelivered(lines, risk);
    });
  }
});
