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
  ...nearMissIssuers(ISSUER),
];

/**
 * The two rejection rows above differ from the configured issuer by ORIGIN, which a compare
 * downgraded to `new URL(x).origin` still catches. In Keycloak every realm on a host shares one
 * origin, so the exact string compare is the only thing separating realm `parley` from realm
 * `corp-everyone` — and each row below is the configured issuer with its PATH perturbed one way.
 */
function nearMissVariants(issuer: string): Array<[string, string]> {
  const { origin, pathname } = new URL(issuer);
  return [
    ['a sibling realm on the same host', `${origin}/realms/corp-everyone`],
    ['a path the configured one has as its prefix', `${origin}${pathname.slice(0, -1)}`],
    ['a path with the configured one as its prefix', `${origin}${pathname}-staging`],
    ['a path differing only in case', `${origin}${pathname.toUpperCase()}`],
    ['a doubled separator', `${origin}//realms/parley`],
    ['a doubled trailing slash', `${origin}${pathname}//`],
    ['the bare origin', origin],
  ];
}

function nearMissIssuers(issuer: string): DiscoveryCase[] {
  const { origin } = new URL(issuer);
  return nearMissVariants(issuer).map(([label, documentIssuer]) => ({
    name: `the document names ${label} (${documentIssuer})`,
    respond: () => json(metadataFor(documentIssuer, `${origin}/certs`)),
    outcome: /does not match configured issuer/,
  }));
}

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

  // A near-miss row that drifted to another origin would still be refused by an origin-only
  // compare, and would count as coverage of a check it no longer reaches.
  it('every near-miss issuer differs from the configured one only below the origin', () => {
    const variants = nearMissVariants(ISSUER);
    expect(variants).toHaveLength(7);
    for (const [, documentIssuer] of variants) {
      expect(documentIssuer).not.toBe(ISSUER);
      expect(new URL(documentIssuer).origin).toBe(new URL(ISSUER).origin);
    }
  });
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

  /**
   * A stub that HONOURS `init.redirect` the way a user agent does, because asserting the literal
   * option pins the flag and not its effect: swap the fetch for a wrapper that drops the option and
   * the flag assertion still passes while the trust root moves. When the option is not 'manual' the
   * redirect target answers with a document naming the CONFIGURED issuer, so nothing downstream of
   * the fetch — least of all the issuer check — can tell it from a direct answer.
   */
  const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

  function redirectHonouring(status: number): Recorder {
    return recording((url) => {
      if (url.startsWith(EVIL)) return json(metadataFor(ISSUER));
      return new Response(null, {
        status,
        headers: { location: `${EVIL}/.well-known/openid-configuration` },
      });
    });
  }

  it.each(REDIRECT_STATUSES.map((s) => [s]))(
    'an HTTP %i cannot reposition the trust root on another origin',
    async (status: number) => {
      const { fetchFn, calls } = redirectHonouring(status);
      const honoured = (async (input: unknown, init?: RequestInit) => {
        const res = await fetchFn(input as string, init);
        if (init?.redirect === 'manual' || res.status < 300 || res.status > 399) return res;
        const location = res.headers.get('location');
        if (location === null) return res;
        return fetchFn(location, init);
      }) as unknown as typeof fetch;

      await expect(fetchOidcDiscovery(ISSUER, honoured)).rejects.toThrow(
        new RegExp(`returned HTTP ${status}`),
      );
      expect(calls.map((c) => c.url)).toEqual([`${ISSUER}/.well-known/openid-configuration`]);
    },
  );
});
