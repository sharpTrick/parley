import { describe, expect, it } from 'vitest';
import { isLoopbackHost, plaintextRemoteOrigin } from '@sharptrick/parley-net-util';

/**
 * A security predicate whose negative answer means "no plaintext-credential risk" may not answer it
 * for a scheme it has never met. `http:` was the only scheme tested, so `ws:` — how Discord's
 * gateway and Slack's Socket Mode carry a bot token — classified as safe, and the one backend that
 * needed the answer had to build its own classifier rather than fix this one.
 *
 * Crossed with the host axis because the two rules compose: the scheme decides whether a credential
 * would be in the clear, the host decides whether it leaves the machine. A cell is the only place a
 * new scheme's classification can be stated, so a scheme added to either side arrives as a row.
 */
const SCHEMES: [scheme: string, cleartext: boolean][] = [
  ['http', true],
  ['ws', true],
  ['https', false],
  ['wss', false],
  // Nothing in the repo dials this today. It is the row that decides the DIRECTION the classifier
  // fails in: an unrecognized scheme is unproven, and an unproven scheme gets the warning.
  ['x-vendor-stream', true],
];

const HOSTS: [host: string, loopback: boolean][] = [
  ['evil.example.com', false],
  ['10.0.0.4:8443', false],
  // Shaped like a loopback address, resolvable as an ordinary name — classified by what it is.
  ['127.0.0.1.example.com', false],
  ['localhost.example.com', false],
  // An IPv4-mapped spelling of a loopback address (as `URL` normalizes it): unproven, so warned
  // about.
  ['[::ffff:7f00:1]', false],
  ['localhost', true],
  ['localhost:9991', true],
  ['127.0.0.1:8080', true],
  ['127.9.9.9', true],
  ['[::1]:6667', true],
];

describe('plaintextRemoteOrigin', () => {
  it('crosses two axes that both discriminate, so the rows below are not one rule', () => {
    expect(new Set(SCHEMES.map(([, cleartext]) => cleartext))).toEqual(new Set([true, false]));
    expect(new Set(HOSTS.map(([, loopback]) => loopback))).toEqual(new Set([true, false]));
  });

  it.each(
    SCHEMES.flatMap(([scheme, cleartext]) =>
      HOSTS.map(([host, loopback]) => [`${scheme}://${host}`, cleartext && !loopback] as const),
    ),
  )('%s warns: %s', (base, warns) => {
    const named = plaintextRemoteOrigin(`${base}/some/path`);
    expect(named).toBe(warns ? base : undefined);
  });

  // The origin, not the configured URL: a secret smuggled into a path or the userinfo must not be
  // what stderr — and the tool result core hands the model — prints.
  it.each([
    ['a path secret', 'http://evil.example.com/bot123:SECRET-CANARY/getMe', 'http://evil.example.com'],
    ['a query secret', 'ws://evil.example.com/gw?token=SECRET-CANARY', 'ws://evil.example.com'],
    ['userinfo', 'http://user:SECRET-CANARY@evil.example.com:8080/p', 'http://evil.example.com:8080'],
  ])('names only the origin for %s', (_label, url, origin) => {
    const named = plaintextRemoteOrigin(url);
    expect(named).toBe(origin);
    expect(named).not.toContain('SECRET-CANARY');
  });

  it.each([
    ['not a url at all', 'not a url'],
    ['a scheme with no host', 'file:///etc/passwd'],
    ['a mail address', 'mailto:ops@example.com'],
    ['an empty string', ''],
  ])('answers undefined for %s, which names no remote endpoint', (_label, value) => {
    expect(plaintextRemoteOrigin(value)).toBeUndefined();
  });
});

describe('isLoopbackHost', () => {
  it.each(HOSTS.map(([host, loopback]) => [host, loopback] as const))(
    '%s is loopback: %s',
    (host, loopback) => {
      // The host axis carries a port where a real config would; the predicate takes a hostname.
      expect(isLoopbackHost(new URL(`http://${host}`).hostname)).toBe(loopback);
    },
  );

  it.each([
    ['LOCALHOST', true],
    ['LocalHost', true],
    ['[::1]', true],
    ['0:0:0:0:0:0:0:1', true],
    ['::1', true],
    ['127.0.0.1', true],
    ['0.0.0.0', false],
    ['::', false],
    ['[::ffff:7f00:1]', false],
    ['example.com', false],
    ['', false],
  ])('classifies the literal %s as loopback: %s', (host, loopback) => {
    expect(isLoopbackHost(host)).toBe(loopback);
  });
});
