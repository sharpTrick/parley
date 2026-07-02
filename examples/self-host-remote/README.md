# Self-host Parley in remote / chat mode

Reference deployment of Parley as a **remote HTTP server with an OAuth front door** (DESIGN §10),
so a Claude chat / web / mobile connector can `post` and `fetch_recent` against your bridge. Same
seam, same SQLite backend as local mode — only the transport/auth layer differs.

**Single-tenant:** this instance authenticates exactly *one* owner (you). The rich config stays
server-side; Claude only ever receives the server URL and a consented token. Backend credentials
never leave the server.

Two auth modes, selected by the `auth:` block in `parley.config.yaml`:

- **Option A (default): built-in OAuth** — Parley is its own OAuth 2.1 + PKCE authorization
  server, gated by your owner passphrase. Steps 1–5 below.
- **Option B: bring your own IdP (Keycloak)** — Parley delegates authorization to an external
  OIDC provider and only validates its tokens. See [Option B](#option-b-bring-your-own-idp-keycloak).

## 1. Build

```bash
npm install && npm run build
```

## 2. Set the owner secret — LOCALLY

The owner secret is the only thing that can authorize this bridge. Hand it to the server
**locally** (env var or stdin) so it never crosses the public internet at setup.

```bash
export PARLEY_OWNER_PASSPHRASE='a long passphrase only you know'
```

Or pre-hash it (so the plaintext isn't in the environment at runtime):

```bash
node -e "import('@sharptrick/parley-core').then(m => console.log(m.hashOwnerSecret(process.argv[1])))" 'your passphrase'
# -> scrypt$....   then:  export PARLEY_OWNER_SECRET_HASH='scrypt$....'
```

## 3. Run behind HTTPS

Claude requires an **HTTPS** public URL for the MCP endpoint. Terminate TLS at a reverse proxy
(Caddy, nginx, a tunnel) and point it at the local server. `PARLEY_ISSUER_URL` must be the public
origin Claude reaches (issuer = base = resource origin, AS = RS).

```bash
PARLEY_ISSUER_URL='https://parley.example.com' \
PORT=3000 HOST=127.0.0.1 \
PARLEY_CONFIG='examples/self-host-remote/parley.config.yaml' \
node examples/self-host-remote/server.ts
```

Example Caddyfile:

```
parley.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

The server exposes (all under your public origin):
- `POST /mcp` — the MCP endpoint (Bearer-protected, Streamable HTTP, stateless).
- `/.well-known/oauth-protected-resource/mcp` — Protected Resource Metadata (RFC 9728).
- `/.well-known/oauth-authorization-server` — AS metadata (RFC 8414).
- `/authorize`, `/token`, `/register` (DCR), `/revoke` — the OAuth 2.1 + PKCE endpoints.
- `/parley/consent` — the owner-consent submit (browser-driven).

## 4. Connect from Claude

Add a custom connector pointing at `https://parley.example.com/mcp`. Claude performs discovery →
**dynamic client registration** → PKCE authorization. On the consent page, enter your **owner
passphrase** to approve. Claude then holds only a short-lived token (with a rotating refresh
token); it never sees your backend credentials.

> **Desktop escape hatch:** clients that don't yet do native remote OAuth can use
> [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) as a local stdio→HTTP proxy that runs
> the full OAuth flow. It does **not** serve claude.ai web/mobile, so it's an option, not the baseline.

## 5. Public-exposure constraint (read this)

In remote mode the bridge **must be internet-reachable** — Claude connects from Anthropic's cloud.
This is the single biggest friction for self-hosting. Mitigate by allowlisting **Anthropic's
published outbound range** at your firewall/WAF:

- **Allowlist inbound from `160.79.104.0/21`** (Anthropic outbound / the connector traffic that
  reaches you). Source: <https://platform.claude.com/docs/en/api/ip-addresses> — verify the
  current range there before relying on it.
- **Exempt** `/. well-known/*`, `/mcp`, and the OAuth paths from any blanket blocking rules.
- **Do not rely on the IP allowlist as the only control** — some Anthropic traffic may originate
  outside the published range. **OAuth is the real security boundary.** Keep the owner secret
  strong and `skip_permissions` OFF.

## Option B: bring your own IdP (Keycloak)

If you already run Keycloak (or any spec-compliant OIDC provider), Parley can delegate the whole
authorization flow to it and act as a pure OAuth **resource server** (RFC 9728). Enable it in
`parley.config.yaml`:

```yaml
auth:
  mode: oidc
  oidc:
    issuer: "https://kc.example.com/realms/myrealm"
    audience: "parley-mcp"          # must match your Keycloak audience mapper
    required_role: "parley-owner"   # recommended: single-tenant gate via a realm role
```

What changes relative to Option A:

- **No owner passphrase** — skip step 2 entirely; your IdP owns login and consent.
  `PARLEY_OWNER_PASSPHRASE` / `PARLEY_OWNER_SECRET_HASH` are not read in this mode.
- **Endpoint surface shrinks** — Parley no longer hosts `/authorize`, `/token`, `/register`,
  `/revoke`, or `/parley/consent`. It serves `POST /mcp`, the Protected Resource Metadata
  (pointing at your realm), and a read-only mirror of the realm's AS metadata.
- Claude discovers your realm from the resource metadata, registers itself there (dynamic
  client registration), and logs in through Keycloak; Parley validates the resulting JWTs
  locally (signature via JWKS, issuer, expiry, audience, and your configured claim gates).
- `PARLEY_PUBLIC_URL` (alias: `PARLEY_ISSUER_URL`) is still the public origin Claude reaches —
  in this mode it is only the resource origin; the OAuth issuer is the realm.

Keycloak needs two pieces of realm setup — an **audience mapper** (Keycloak ignores RFC 8707
`resource` parameters, so the token's `aud` claim must be injected) and a **client-registration
trusted-hosts policy** so Claude can register. Both are covered step by step in
[docs/keycloak-integration.md](../../docs/keycloak-integration.md).

## Security summary

- Single-tenant OAuth 2.1 + PKCE; one owner, gated by user consent.
- Owner credential handoff is local (env/stdin/hash); the plaintext is never stored and never
  crosses the internet at setup.
- Backend credentials stay server-side; Claude only holds a consented, audience-bound token.
- Inbound topic content is untrusted data, never privileged instructions (DESIGN §14).
