/**
 * Remote-mode auth config: the built-in single-tenant OAuth AS (default) or an external OIDC IdP
 * (e.g. Keycloak) — the delegated resource-server variant of DESIGN §10. In OIDC mode Parley hosts
 * no /authorize,/token,/register; it publishes Protected Resource Metadata pointing at the issuer
 * and validates inbound Bearer JWTs locally. Nothing here is a secret (issuer/audience/claim policy
 * are public-side config).
 */
import { z } from 'zod';

export const OidcAuthSchema = z
  .object({
    /** OIDC issuer, e.g. https://kc.example.com/realms/myrealm. Discovery is fetched from
     *  `<issuer>/.well-known/openid-configuration` at startup. Must be https — the JWKS trust
     *  root depends on TLS — except on loopback, where test/dev fakes serve over http. */
    issuer: z
      .string()
      .url()
      .refine(
        (u) => {
          const url = new URL(u);
          return (
            url.protocol === 'https:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost'
          );
        },
        { message: 'auth.oidc.issuer must use https (the JWKS trust root depends on TLS)' },
      ),
    /** Expected `aud` value. Default: the canonical resource id (public URL + mcpPath). Keycloak
     *  ignores RFC 8707 `resource`, so an audience mapper must emit this exact string — see
     *  docs/keycloak-integration.md. */
    audience: z.string().min(1).optional(),
    /** Override the JWKS URI (default: `jwks_uri` from discovery). */
    jwks_uri: z.string().url().optional(),
    /** If set, the token's `scope` (space-separated) must include this value. */
    required_scope: z.string().min(1).optional(),
    /** Identity gates preserving the single-tenant posture: any that are set must ALL pass.
     *  Issuer + audience validation is always mandatory regardless. */
    allowed_subjects: z.array(z.string().min(1)).nonempty().optional(),
    /** Matched against the `preferred_username` claim. */
    allowed_usernames: z.array(z.string().min(1)).nonempty().optional(),
    /** Required realm role (Keycloak `realm_access.roles`). */
    required_role: z.string().min(1).optional(),
    /** exp/nbf tolerance in seconds. */
    clock_skew_s: z.number().int().min(0).max(300).default(30),
  })
  .strict();

export type OidcAuthConfig = z.infer<typeof OidcAuthSchema>;

/** Remote-mode auth selection: the built-in single-tenant OAuth AS (default) or external OIDC. */
export const AuthSchema = z
  .object({
    mode: z.enum(['builtin', 'oidc']).default('builtin'),
    oidc: OidcAuthSchema.optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.mode !== 'oidc') return;
    if (a.oidc === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['oidc'],
        message: 'auth.mode "oidc" requires an auth.oidc block',
      });
      return;
    }
    // Delegated OIDC has no owner-consent step, so an identity gate is the ONLY thing that
    // keeps a shared/corporate realm from authorizing every realm user. Require at least one.
    // `required_scope` alone is insufficient (Claude's connector may request no scopes).
    const { allowed_subjects, allowed_usernames, required_role } = a.oidc;
    if (
      allowed_subjects === undefined &&
      allowed_usernames === undefined &&
      required_role === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['oidc'],
        message:
          'auth.mode "oidc" requires an identity gate: set at least one of ' +
          'allowed_subjects / allowed_usernames / required_role to preserve the single-tenant ' +
          'posture (required_scope alone is not sufficient). See docs/keycloak-integration.md.',
      });
    }
  });

export type AuthConfig = z.infer<typeof AuthSchema>;
