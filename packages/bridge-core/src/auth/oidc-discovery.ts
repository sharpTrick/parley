import {
  OAuthMetadataSchema,
  type OAuthMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * Fetch and validate the external IdP's discovery document. Uses the OIDC form — the well-known
 * suffix is APPENDED to the issuer path (`<issuer>/.well-known/openid-configuration`, what
 * Keycloak serves at `/realms/<realm>/...`) — rather than the RFC 8414 form which inserts it
 * before the path. The `issuer` inside the document must match the configured issuer
 * (trailing-slash-normalized); a mismatch means misconfiguration or an issuer-spoofing IdP.
 *
 * Runs once at boot: errors are descriptive so the operator can see WHY startup failed.
 */
export async function fetchOidcDiscovery(
  issuer: string,
  fetchFn: typeof fetch = fetch,
): Promise<OAuthMetadata> {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
  const url = new URL('.well-known/openid-configuration', base).href;

  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (err) {
    throw new Error(
      `OIDC discovery failed: cannot reach ${url} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${url} returned HTTP ${res.status}`);
  }

  let metadata: OAuthMetadata;
  try {
    metadata = OAuthMetadataSchema.parse(await res.json());
  } catch (err) {
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
