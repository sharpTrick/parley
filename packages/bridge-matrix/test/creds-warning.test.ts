import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixPlugin } from '../src/index.js';

/**
 * CLASS: a security posture that exists only in prose. Every config key that widens this backend's
 * trust boundary must announce itself on the operator's stderr — a README paragraph is invisible to
 * whoever copied a fixture config into production, and the repo's own conformance fixture is exactly
 * such a config. connect() does live I/O (the m.login.password POST), so fetch is stubbed with a
 * valid login; each warning fires before it, and the whole connect() must still resolve so the gate
 * sits on the happy path rather than an incidental network failure.
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
    /** Identifies the line, then the key an operator sets and the mitigation it must name. */
    signature: /default password/,
    names: ['backend_config.password', 'parleypass'],
  },
  'shared_room': {
    apply: (c: Record<string, unknown>) => ({ ...c, shared_room: 'parley_all' }),
    signature: /backend_config\.shared_room/,
    names: ['app.parley.topic', 'Leave shared_room unset in production'],
  },
  'room_preset public_chat': {
    apply: (c: Record<string, unknown>) => ({ ...c, room_preset: 'public_chat' }),
    signature: /backend_config\.room_preset/,
    names: ['public_chat', "default 'private_chat'"],
  },
  'a plaintext homeserver_url': {
    apply: (c: Record<string, unknown>) => ({ ...c, homeserver_url: REMOTE_PLAINTEXT }),
    signature: /backend_config\.homeserver_url/,
    names: [REMOTE_PLAINTEXT, 'm.login.password', 'access token', 'https://'],
  },
} as const;

type RiskName = keyof typeof RISKS;
const RISK_NAMES = Object.keys(RISKS) as RiskName[];

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

      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toHaveLength(active.length);
      for (const name of RISK_NAMES) {
        const matched = lines.filter((l) => RISKS[name].signature.test(l));
        expect(matched, name).toHaveLength(active.includes(name) ? 1 : 0);
        for (const mention of active.includes(name) ? RISKS[name].names : []) {
          expect(matched[0]).toContain(mention);
        }
      }
      for (const line of lines) expect(line).toContain('[parley-matrix]');
    });
  }
});

/**
 * The plaintext row above proves the warning EXISTS; this table proves it is decided by what the
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

describe('the plaintext-credential warning is decided by the host, not by its spelling', () => {
  for (const [homeserverUrl, warns] of Object.entries(ORIGINS)) {
    it(`${homeserverUrl}: ${warns ? 'warns' : 'silent'}`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => okLogin()));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await new MatrixPlugin().connect({ ...SAFE, homeserver_url: homeserverUrl });

      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => /backend_config\.homeserver_url/.test(l))).toHaveLength(
        warns ? 1 : 0,
      );
      expect(lines).toHaveLength(warns ? 1 : 0);
    });
  }
});
