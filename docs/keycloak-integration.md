# Keycloak integration — external OIDC auth for remote/chat mode

Parley's remote/chat mode ships two interchangeable auth front doors, selected by the `auth:`
block in the bridge config:

- **`builtin` (default)** — Parley is its own single-tenant OAuth 2.1 + PKCE authorization
  server, gated by an owner passphrase (DESIGN §10). Zero external moving parts.
- **`oidc`** — Parley delegates the whole authorization flow to an external OIDC provider and
  acts as a pure OAuth **resource server** (RFC 9728). Keycloak is the documented and
  integration-tested target, but any spec-compliant IdP works.

This guide covers the `oidc` mode: architecture, the exact Keycloak realm setup, the Parley
config reference, and how it's tested.

## Architecture: delegated resource server

In `builtin` mode the authorization server (AS) and resource server (RS) are the same origin.
In `oidc` mode they split:

```
builtin:   Claude ──OAuth+MCP──▶ Parley (AS = RS, owner passphrase consent)

oidc:      Claude ──OAuth─────▶ Keycloak realm (AS: login, consent, tokens)
                 └──MCP+JWT───▶ Parley        (RS: validates tokens, serves /mcp)
```

The flow, end to end:

1. Claude's connector hits `POST /mcp` unauthenticated and receives
   `401` + `WWW-Authenticate: Bearer ... resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
2. The Protected Resource Metadata lists your **Keycloak realm issuer** in
   `authorization_servers`.
3. Claude fetches the realm's discovery document, **registers itself** via dynamic client
   registration (RFC 7591), and runs the OAuth 2.1 + PKCE authorization-code flow against
   Keycloak. You log in with your Keycloak account.
4. Claude calls `/mcp` with the resulting Bearer JWT. Parley validates it **locally** — no
   per-request round-trip to Keycloak:
   - signature via the realm's JWKS (keys are fetched and cached by `kid`; rotation is handled
     automatically),
   - `iss` must equal the configured issuer,
   - `exp` / `nbf` within the configured clock skew,
   - `aud` must contain the configured audience (**always enforced** — see the audience mapper
     below),
   - plus any configured claim gates (`required_role`, `allowed_usernames`, …).

What Parley **no longer hosts** in this mode: `/authorize`, `/token`, `/register`, `/revoke`,
and the owner-consent page. It serves `POST /mcp`, the Protected Resource Metadata, and a
read-only mirror of the realm's AS metadata at `/.well-known/oauth-authorization-server` (for
older clients that probe the resource origin). No owner passphrase exists in this mode — your
IdP owns login.

At startup Parley fetches `<issuer>/.well-known/openid-configuration` once (issuer sanity check
+ JWKS location), so Keycloak must be reachable when the bridge boots.

## Keycloak realm setup

Tested against Keycloak 26.x. Everything below is admin-console work inside the realm you'll
use (don't use `master`).

### 1. The audience mapper (load-bearing — do not skip)

Keycloak **ignores** RFC 8707 `resource` parameters, so tokens it mints carry `aud: ["account"]`
by default — and Parley (correctly) rejects every one of them with 401. You must inject the
audience yourself:

1. **Client scopes → Create client scope.** Name it `parley-aud`, type **Default**,
   protocol **OpenID Connect**.
2. Inside the scope: **Mappers → Configure a new mapper → Audience.**
   - Name: `parley-audience`
   - **Included Custom Audience:** a fixed string identifying your bridge, e.g. `parley-mcp`
     (or the canonical resource URL, e.g. `https://parley.example.com/mcp`)
   - **Add to access token:** ON
3. Make the scope a **realm default** (Client scopes list → `parley-aud` → *Assigned type:
   Default*). This matters: Claude registers its client dynamically, and a DCR'd client only
   inherits the mapper if the scope is a realm default. Assigning the scope to a single
   hand-made client is not enough.
4. Put the same string in Parley's `auth.oidc.audience`.

> Because the audience is pinned per scope rather than derived from the request's `resource`
> parameter, one realm default scope serves one bridge audience. If you run several bridges
> against one realm, create one scope per bridge and assign them per client instead of as realm
> defaults (each pre-registered client gets its bridge's scope), or use distinct realms.

### 2. Dynamic client registration for Claude's connector

Claude's connector registers itself against the realm's registration endpoint (anonymous DCR).
Keycloak restricts anonymous DCR with **client-registration policies**
(realm → **Clients → Client registration → Anonymous access policies**):

- **Trusted Hosts** policy: add the hosts Claude registers from, or the policy rejects the
  registration outright. Anthropic's connector traffic originates from their published egress
  range (see <https://platform.claude.com/docs/en/api/ip-addresses>). If the policy's
  *Client URIs must match* is on, Claude's redirect URI must resolve within trusted hosts —
  turn it off (consciously) or trust `claude.ai`.
- Claude's redirect URI is `https://claude.ai/api/mcp/auth_callback` (web/mobile/desktop).
  Claude Code additionally uses ephemeral loopback redirects (`http://127.0.0.1:<port>/callback`).
- Keep the other anonymous policies (allowed protocol mappers, consent-required, max clients)
  at their defaults unless they block registration; review what a policy relaxation exposes
  before changing it.

#### Alternative: pre-register a client (no anonymous DCR)

If your realm forbids anonymous registration (common on shared/corporate Keycloak), skip DCR
entirely — Claude's custom-connector settings accept a pre-registered OAuth client ID and
secret. This keeps the realm fully locked down and makes the client explicit and auditable:

1. **Clients → Create client.** Client ID e.g. `claude-connector`, protocol OpenID Connect.
   Enable **Client authentication** (confidential) — or leave it public; Claude supports both.
2. **Valid redirect URIs:** `https://claude.ai/api/mcp/auth_callback` (exactly; no wildcard
   needed — the chat connector's callback is fixed).
3. **Client scopes tab:** add `parley-aud` as a **Default** scope for this client (required if
   you didn't make it a realm default in step 1 above).
4. If confidential: **Credentials tab** → copy the client secret.
5. In Claude's connector dialog, expand the advanced/OAuth settings and paste the client ID
   (and secret). Claude then skips registration and goes straight to the PKCE login flow.

No Parley configuration changes — token validation is identical in both variants.

### 3. The owner identity (single-tenant gate)

With the built-in auth, the owner passphrase makes the bridge single-tenant. With Keycloak,
**any realm user who can log in gets a perfectly valid token** — so re-establish the
single-tenant posture with claim gates:

1. **Realm roles → Create role:** `parley-owner`.
2. Assign it to your own user (**Users → you → Role mapping**).
3. Set `required_role: "parley-owner"` in Parley's config.

`allowed_usernames` / `allowed_subjects` work too (see the reference below); `required_role` is
recommended because it survives username changes and is explicit in the Keycloak UI. Prefer
`required_role` over `required_scope`: Claude's connector may request no scopes at all, so a
scope requirement only works if your realm maps a default scope into every token.

## Parley config reference

```yaml
# parley.config.yaml (server-side, next to the bridge — never pasted into Claude)
auth:
  mode: oidc
  oidc:
    # Required. The realm issuer; discovery is fetched from
    # <issuer>/.well-known/openid-configuration at startup.
    issuer: "https://kc.example.com/realms/myrealm"

    # The `aud` value to require. Default: the canonical resource id
    # (public URL + /mcp). With Keycloak, set it to your audience mapper's string.
    audience: "parley-mcp"

    # Identity gates — any that are set must ALL pass (issuer + audience are
    # always enforced regardless).
    required_role: "parley-owner"        # realm_access.roles must contain this
    # allowed_usernames: ["alice"]       # preferred_username allowlist
    # allowed_subjects: ["<uuid>"]       # sub allowlist (survives renames)
    # required_scope: "mcp"              # only if your IdP maps a default scope

    # Rarely needed:
    # jwks_uri: "https://kc.example.com/realms/myrealm/protocol/openid-connect/certs"
    # clock_skew_s: 30                   # exp/nbf tolerance, 0–300
```

Run the reference server ([examples/self-host-remote](../examples/self-host-remote/README.md))
with `PARLEY_PUBLIC_URL` set to the public origin Claude reaches. No
`PARLEY_OWNER_PASSPHRASE` / `PARLEY_OWNER_SECRET_HASH` is needed (or read) in this mode.

In code, the same selection is `createRemoteAuthApp(plugin, cfg, { publicUrl })`, which
dispatches on `cfg.auth.mode`; the OIDC composition is also available directly as
`createOidcRemoteApp`.

## Security notes

- **Issuer + audience validation is not optional** and cannot be configured off. Audience
  binding is what stops a token minted for some other service in the same realm from reaching
  your bridge (token-passthrough/confused-deputy).
- **Claim-gate failures return 401, not 403**, and all validation failures share one error
  message — an unauthorized caller learns nothing about which check failed or what the gate
  policy is.
- **Configure at least one identity gate.** Without one, every user in the realm who can log
  in can drive your bridge; `required_role` is the recommended minimum.
- Token lifetime, refresh, and revocation are Keycloak's: Parley honors `exp` on every request
  and picks up signing-key rotation via JWKS automatically. Keycloak's default 5-minute access
  tokens with refresh work fine — Claude refreshes proactively.
- Keep both Keycloak and Parley behind TLS; the token is a bearer credential.
- The general remote-mode guidance still applies (DESIGN §14): Anthropic IP-range allowlisting
  helps, but **OAuth is the real security boundary**; inbound topic content stays untrusted
  data; `skip_permissions` stays off.

## Testing

Three tiers cover this mode:

- **Always-run** (`npm test`): `packages/bridge-core/src/auth/oidc-verifier.test.ts` and
  `oidc-remote.test.ts` run against an in-process fake IdP
  (`packages/bridge-core/src/testing/fake-oidc.ts`) that serves discovery + JWKS and mints real
  RS256 JWTs — valid/expired/wrong-aud/wrong-iss/rogue-key tokens, scope and identity gates,
  and full MCP tool calls through the real SDK client. `examples/self-host-remote/test/oidc-smoke.test.ts`
  boots the reference server from YAML alone.
- **Gated, real Keycloak:** `packages/bridge-core/src/auth/keycloak.e2e.test.ts` self-skips
  unless a realm answers at `http://127.0.0.1:8080/realms/parley` (override with
  `PARLEY_KEYCLOAK_URL`). Stand one up with the maintainer dev compose — realm, users, roles,
  and the audience mapper are imported automatically:

  ```bash
  docker compose -f examples/dev-compose/docker-compose.yml up -d keycloak
  npx vitest run packages/bridge-core/src/auth/keycloak.e2e.test.ts
  ```

  See [examples/dev-compose/README.md](../examples/dev-compose/README.md) for the imported
  realm's contents (users `parley`/`stranger`, password `parleypass`).
