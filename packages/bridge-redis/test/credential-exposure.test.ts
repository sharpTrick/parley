import { describe, expect, it } from 'vitest';
import { type RedisBackendConfig, RedisPlugin } from '../src/index.js';
import { FAST_MS as FAST, freeEndpoint } from './support.js';

// CLASS: a `backend_config` that would put this bridge's own credential on the wire in the clear,
// accepted in silence. `url` is the only place a Redis password can live, both the README quickstart
// and `examples/multi-session` point several sessions at ONE shared server, and nothing about a
// working bridge tells an operator that every host on the path can read the AUTH it sends and post
// as it. Six other backends in this repo report exactly this; redis reported nothing.
//
// Two axes: the URL's PROPERTIES — scheme, whether it carries a credential at all, and whether the
// host is loopback — and the DIRECTION of the verdict, since a rule that only ever warns is
// satisfied by warning about everything. The silent rows are what make the loud ones mean anything.
//
// Decided before any server is reached, so nothing here needs one and nothing here can skip.

/** The value that must never appear in a line about the URL that carries it. */
const SECRET = 's3cret';

interface Capture {
  stderr: string[];
  stdout: string[];
}

/** Drive `connect()` with both standard streams captured; the endpoint need not exist. */
async function connecting(config: RedisBackendConfig): Promise<Capture> {
  const out: Capture = { stderr: [], stdout: [] };
  const original = { err: process.stderr.write, out: process.stdout.write };
  const capture =
    (into: 'stderr' | 'stdout') =>
    (chunk: string | Uint8Array): boolean => {
      out[into].push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
  process.stderr.write = capture('stderr') as typeof process.stderr.write;
  process.stdout.write = capture('stdout') as typeof process.stdout.write;
  const plugin = new RedisPlugin();
  try {
    await plugin.connect({ connect_timeout_ms: FAST, ...config }).catch(() => undefined);
  } finally {
    process.stderr.write = original.err;
    process.stdout.write = original.out;
    await plugin.disconnect().catch(() => undefined);
  }
  return out;
}

const securityLines = (capture: Capture): string[] =>
  capture.stderr.filter((line) => line.includes('SECURITY'));

const remote = (host: string, scheme = 'redis'): string => `${scheme}://parley:${SECRET}@${host}`;

const exposed: Array<[string, string]> = [
  ['a named host', remote('bus.example.test:6379')],
  ['a routable IPv4 literal', remote('203.0.113.9:6379')],
  ['a routable IPv6 literal', remote('[2001:db8::1]:6379')],
  ['a host merely SHAPED like loopback', remote('127.0.0.1.example.test:6379')],
  ['a subdomain of localhost', remote('localhost.example.test:6379')],
  ['an IPv4-mapped spelling of loopback, which is not loopback', remote('[::ffff:127.0.0.1]:6379')],
  ['a username with no password', 'redis://parley@bus.example.test:6379'],
  ['no port at all', remote('bus.example.test')],
];

const safe: Array<[string, () => Promise<RedisBackendConfig> | RedisBackendConfig]> = [
  ['TLS to the same remote host', () => ({ url: remote('bus.example.test:6379', 'rediss') })],
  ['no credential to lose', () => ({ url: 'redis://bus.example.test:6379' })],
  ['loopback by name', () => ({ url: remote('localhost') })],
  ['loopback by IPv6 literal', () => ({ url: remote('[::1]') })],
  [
    'loopback by IPv4 literal',
    async () => ({ url: (await freeEndpoint()).replace('//', `//parley:${SECRET}@`) }),
  ],
  ['the default endpoint, which no operator configured', () => ({})],
];

describe('bridge-redis — a credential bound for a cleartext remote link is reported', () => {
  it.each(exposed)('%s', async (_label, url) => {
    const capture = await connecting({ url });
    const [line = ''] = securityLines(capture);
    expect(line, `connect() accepted ${url} in silence`).not.toBe('');
    expect(line, 'the warning does not name the origin an operator has to change').toContain(
      new URL(url).host,
    );
    expect(line, 'the warning prints the credential it is warning about').not.toContain(SECRET);
    expect(
      capture.stdout,
      'a diagnostic went to stdout, which is the MCP JSON-RPC channel',
    ).toEqual([]);
  });
});

describe('bridge-redis — a URL with nothing to expose is reported on by nothing', () => {
  it.each(safe)('%s', async (_label, mint) => {
    const capture = await connecting(await mint());
    expect(
      securityLines(capture),
      'a URL that exposes no credential was warned about, so the warning means nothing when it ' +
        'does fire and an operator learns to ignore it',
    ).toEqual([]);
  });
});
