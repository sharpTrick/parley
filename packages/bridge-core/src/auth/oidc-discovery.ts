import {
  OAuthMetadataSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  type OpenIdProviderDiscoveryMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * The IdP's discovery document, keeping the RFC 8414 fields the OIDC schema alone drops.
 *
 * `OpenIdProviderDiscoveryMetadataSchema` is a strict `z.object`, so parsing through it STRIPS every
 * key it does not name — including `revocation_endpoint` and `introspection_endpoint`, which a stock
 * Keycloak realm publishes. In delegated mode this parsed document is what the AS-metadata mirror on
 * Parley's origin is built from, so a client that discovers the IdP through Parley had no revocation
 * endpoint to call and no way to tell truncation from absence.
 *
 * Derive the added keys from the two schemas rather than listing them, so an RFC 8414 field the SDK
 * learns about later is mirrored without an edit here. Keep the OIDC shape WINNING on shared keys,
 * so that widening the mirror cannot tighten what a legitimate IdP is allowed to publish.
 */
const DiscoveryDocumentSchema = OpenIdProviderDiscoveryMetadataSchema.extend(
  OAuthMetadataSchema.shape,
).extend(OpenIdProviderDiscoveryMetadataSchema.shape);

/**
 * How long the whole exchange — connect, headers, body — may take. `createOidcRemoteApp` awaits
 * this before anything listens, so without a deadline an issuer that accepts the connection and
 * then answers nothing leaves the operator with a process that prints nothing, binds no port and
 * fails its health check indistinguishably from a hung backend.
 */
export const DISCOVERY_TIMEOUT_MS = 10_000;

function isDeadline(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function unreachable(url: string, timeoutMs: number, err: unknown): Error {
  const why = isDeadline(err)
    ? `no response within ${timeoutMs}ms`
    : err instanceof Error
      ? err.message
      : String(err);
  return new Error(`OIDC discovery failed: cannot reach ${url} (${why})`);
}

/**
 * Fetch and validate the external IdP's discovery document. Uses the OIDC form — the well-known
 * suffix is APPENDED to the issuer path (`<issuer>/.well-known/openid-configuration`, what
 * Keycloak serves at `/realms/<realm>/...`) — rather than the RFC 8414 form which inserts it
 * before the path. The `issuer` inside the document must match the configured issuer
 * (trailing-slash-normalized); a mismatch means misconfiguration or an issuer-spoofing IdP.
 *
 * Runs once at boot, under a deadline: errors are descriptive so the operator can see WHY startup
 * failed.
 */
export async function fetchOidcDiscovery(
  issuer: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
): Promise<OpenIdProviderDiscoveryMetadata> {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
  const url = new URL('.well-known/openid-configuration', base).href;
  // Keep ONE signal across the fetch and the body read, so that an issuer which answers with
  // headers and then dribbles the body is bounded by the same deadline as one that never answers.
  const signal = AbortSignal.timeout(timeoutMs);

  let res: Response;
  try {
    // Keep `redirect: 'manual'`, so that a 3xx cannot move the trust root to another origin
    // before the issuer check ever sees the document.
    res = await fetchFn(url, { redirect: 'manual', signal });
  } catch (err) {
    throw unreachable(url, timeoutMs, err);
  }
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${url} returned HTTP ${res.status}`);
  }

  let metadata: OpenIdProviderDiscoveryMetadata;
  try {
    metadata = DiscoveryDocumentSchema.parse(await res.json());
  } catch (err) {
    if (isDeadline(err)) throw unreachable(url, timeoutMs, err);
    throw new Error(
      `OIDC discovery failed: ${url} returned an invalid document (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (stripSlash(metadata.issuer) !== stripSlash(issuer)) {
    throw new Error(
      `OIDC discovery failed: document issuer "${metadata.issuer}" does not match configured issuer "${issuer}"`,
    );
  }
  return metadata;
}

function stripSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
