import { describe, expect, it } from 'vitest';
import { fetchOidcDiscovery } from './oidc-discovery.js';

const ISSUER = 'https://kc.example.com/realms/parley';
const EVIL = 'https://evil.example/realms/parley';

function metadataFor(issuer: string, jwksUri = `${issuer}/protocol/openid-connect/certs`): unknown {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: jwksUri,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Recorder {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
}

function recording(respond: (url: string) => Response): Recorder {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(String(input));
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/**
 * `fetchOidcDiscovery` establishes the trust root of delegated-OIDC mode: whatever this document
 * says becomes the expected `iss` and the JWKS location. Every rejection branch is therefore a
 * security control, and every one of them must be reachable and load-bearing — a branch nothing
 * drives is a branch that can be deleted without a single test noticing.
 */
interface DiscoveryCase {
  name: string;
  respond: (url: string) => Response;
  configuredIssuer?: string;
  /** A RegExp the thrown message must match, or 'resolves' for the accepted rows. */
  outcome: RegExp | 'resolves';
}

const DISCOVERY_CASES: DiscoveryCase[] = [
  {
    name: 'the issuer is unreachable',
    respond: () => {
      throw new TypeError('fetch failed');
    },
    outcome: /cannot reach .*\.well-known\/openid-configuration.*fetch failed/,
  },
  {
    name: 'HTTP 404 carrying an otherwise valid-looking document',
    respond: () => json(metadataFor(ISSUER), 404),
    outcome: /returned HTTP 404/,
  },
  {
    name: 'HTTP 500 carrying an otherwise valid-looking document',
    respond: () => json(metadataFor(ISSUER), 500),
    outcome: /returned HTTP 500/,
  },
  {
    name: 'HTTP 302 redirecting the trust root to another origin',
    respond: () =>
      new Response(null, { status: 302, headers: { location: `${EVIL}/.well-known/x` } }),
    outcome: /returned HTTP 302/,
  },
  {
    name: 'the body is not JSON at all',
    respond: () => new Response('<html>login</html>', { status: 200 }),
    outcome: /invalid document/,
  },
  {
    name: 'the body is JSON but fails the metadata schema',
    respond: () => json({ hello: 'world' }),
    outcome: /invalid document/,
  },
  {
    name: 'the document names a different issuer',
    respond: () => json(metadataFor(EVIL)),
    outcome: /document issuer "https:\/\/evil\.example[^"]*" does not match configured issuer/,
  },
  {
    name: 'the document is internally self-consistent but describes someone else entirely',
    respond: () => json(metadataFor(EVIL, `${EVIL}/certs`)),
    outcome: /does not match configured issuer/,
  },
  {
    name: 'the document issuer omits a trailing slash the operator configured',
    respond: () => json(metadataFor(ISSUER)),
    configuredIssuer: `${ISSUER}/`,
    outcome: 'resolves',
  },
  {
    name: 'the document issuer carries a trailing slash the operator omitted',
    respond: () => json(metadataFor(`${ISSUER}/`)),
    outcome: 'resolves',
  },
  {
    name: 'the document matches the configured issuer exactly',
    respond: () => json(metadataFor(ISSUER)),
    outcome: 'resolves',
  },
];

describe('fetchOidcDiscovery — every rejection branch of the boot-time trust-root fetch', () => {
  it.each(DISCOVERY_CASES.map((c) => [c.name, c]))(
    'when %s',
    async (_name: string, c: DiscoveryCase) => {
      const { fetchFn } = recording(c.respond);
      const call = fetchOidcDiscovery(c.configuredIssuer ?? ISSUER, fetchFn);
      if (c.outcome === 'resolves') {
        await expect(call).resolves.toMatchObject({ issuer: expect.stringContaining(ISSUER) });
        return;
      }
      await expect(call).rejects.toThrow(/^OIDC discovery failed:/);
      await expect(call).rejects.toThrow(c.outcome);
    },
  );
});

describe('fetchOidcDiscovery — the request itself', () => {
  const WELL_KNOWN_SHAPES: Array<[string, string]> = [
    [ISSUER, `${ISSUER}/.well-known/openid-configuration`],
    [`${ISSUER}/`, `${ISSUER}/.well-known/openid-configuration`],
  ];

  it.each(WELL_KNOWN_SHAPES)(
    'appends the OIDC well-known suffix to %s',
    async (issuer: string, expected: string) => {
      const { fetchFn, calls } = recording(() => json(metadataFor(ISSUER)));
      await fetchOidcDiscovery(issuer, fetchFn);
      expect(calls.map((c) => c.url)).toEqual([expected]);
    },
  );

  it('refuses to follow a redirect rather than letting one reposition the trust root', async () => {
    const { fetchFn, calls } = recording(() => json(metadataFor(ISSUER)));
    await fetchOidcDiscovery(ISSUER, fetchFn);
    expect(calls[0]?.init?.redirect).toBe('manual');
  });
});
