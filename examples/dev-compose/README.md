# Dev-compose — throwaway infra for testing the network backends

This is the maintainer-facing **"how we test"** harness (DESIGN §15), not a production recipe.
Each network plugin's own README points at the canonical upstream Docker setup; this compose just
stands up disposable instances so the shared conformance suite can run against a real server.

## Quick start — `dev-infra.sh`

The suites self-detect a server at its default localhost URL and otherwise **skip**. `dev-infra.sh`
brings one up, seeds the test account the conformance factory expects (**user `parley`, password
`parleypass`**), and optionally runs that backend's suite — one command, idempotent:

```bash
cd examples/dev-compose
./dev-infra.sh test redis      # up + wait healthy + seed user, then run bridge-redis's suite
./dev-infra.sh test matrix     # handles Synapse's generate + IPv4 fix + overrides + register for you
./dev-infra.sh up all          # just bring everything up (redis nats postgres xmpp matrix)
./dev-infra.sh logs matrix     # tail a server's logs
./dev-infra.sh down            # stop & remove everything, including volumes
```

`backend ∈ { redis, nats, postgres, xmpp, matrix, all }`. Needs a running Docker daemon +
`docker compose`. Everything below documents what the script does (and how to do it by hand).

### Where each suite looks (override with env vars)

| Backend  | Default the suite probes                              | Override env var(s) |
|----------|-------------------------------------------------------|---------------------|
| Redis    | `redis://127.0.0.1:6379`                              | `PARLEY_REDIS_URL` |
| NATS     | `127.0.0.1:4222`                                      | `PARLEY_NATS_SERVERS` |
| Postgres | `postgres://parley:parley@127.0.0.1:5432/parley`      | `PARLEY_PG_URL` |
| XMPP     | `xmpp://127.0.0.1:5222` (`parley`/`parleypass`)       | `PARLEY_XMPP_SERVICE` / `_DOMAIN` / `_MUC` / `_USER` / `_PASS` |
| Matrix   | `http://127.0.0.1:8008` (`parley`/`parleypass`)       | `PARLEY_MATRIX_URL` / `_SERVER_NAME` / `_USER` / `_PASSWORD` |

Bring up only what you're working on (plain compose, if you prefer it over the script):

```bash
docker compose up redis      # v0.3
docker compose up nats       # v0.5
docker compose up postgres   # v0.6
docker compose up prosody    # v0.5 XMPP (MAM enabled in prosody/prosody.cfg.lua)
docker compose up synapse    # v0.4 Matrix (see the Synapse notes below)
docker compose up keycloak   # post-v1 external-OIDC auth mode
```

## Redis (v0.3) — ready to run

`redis:7-alpine` on `localhost:6379`. Streams are built in (`XADD`/`XRANGE`/`XREAD BLOCK`), and
`XREAD BLOCK` also backs the native `block_ms` long-poll. The conformance factory points at
`redis://127.0.0.1:6379`.

## NATS (v0.5) — ready to run

`nats:2.10-alpine` with JetStream (`-js`) on `localhost:4222` (monitoring on `:8222`). JetStream
sequence numbers are the cursor; a pull consumer with an expiry backs the native `block_ms`.

## Postgres (v0.6) — ready to run

`postgres:16-alpine` on `localhost:5432`, user/db `parley`/`parley` (password `parley`).
`BIGSERIAL` seq is the cursor; `LISTEN`/`NOTIFY` drives both `subscribe` and the native `block_ms`.
The suite probes `postgres://parley:parley@127.0.0.1:5432/parley` (`PARLEY_PG_URL`) and self-skips
when no server is up. No Docker handy? A plain `apt install postgresql` cluster with the same
user/db works identically.

## Prosody / XMPP (v0.5) — MAM required

`prosody/prosody:latest` with the mounted `prosody/prosody.cfg.lua` (MAM + a MUC component at
`muc.parley.local`). In-band registration is on for dev. Register the test account — note the
password is **`parleypass`** to match the conformance factory:

```bash
docker compose up -d prosody
docker compose exec prosody prosodyctl register parley parley.local parleypass
```

(`./dev-infra.sh up xmpp` does both.) The mod_smacks / TLS-cert warnings in the log are expected on
this plaintext localhost dev server and harmless.

## Synapse / Matrix (v0.4)

**Easiest: `./dev-infra.sh up matrix`** (or `test matrix`) — it does the whole dance below.

Doing it by hand takes three careful steps, because two Synapse defaults break a throwaway run:

1. **Generate** the config (once):

   ```bash
   docker compose run --rm --entrypoint /start.py \
     -e SYNAPSE_SERVER_NAME=parley.local -e SYNAPSE_REPORT_STATS=no synapse generate
   ```

2. **Fix two dev gotchas** in the generated `homeserver.yaml` (in the `synapse-data` volume):
   - **IPv6 bind** — the 8008 listener binds `::` as well as `0.0.0.0`; a container without IPv6
     dies at startup (`Couldn't listen on :::8008`). Add `bind_addresses: ["0.0.0.0"]` to that
     listener.
   - **Rate limits** — the suite's per-test logins/joins/sends get throttled into
     `beforeEach`/`afterEach` hook timeouts. Append [`synapse/dev-overrides.yaml`](synapse/dev-overrides.yaml)
     (relaxed `rc_*` limiters) to `homeserver.yaml`. (`generate` already writes a
     `registration_shared_secret`, so the overrides file deliberately does **not** set one — a
     second would be a duplicate key.)

3. **Start it and register** the test user — password **`parleypass`**:

   ```bash
   docker compose up -d synapse
   docker compose exec synapse register_new_matrix_user \
     -u parley -p parleypass -a -c /data/homeserver.yaml http://localhost:8008
   ```

`server_name=parley.local`, C–S API on `localhost:8008`. Room → topic, sync token → cursor; a
bounded room-filtered `/sync` backs the native `block_ms`.

## Zulip (v0.6) — upstream compose, not authored here

Zulip's self-host stack is multi-container and config-heavy; per DESIGN §15 use the canonical
[`zulip/docker-zulip`](https://github.com/zulip/docker-zulip) setup. The `bridge-zulip`
conformance tests run against an **in-process fake** by default (no server needed); with a real
server up, set `PARLEY_ZULIP_URL` / `PARLEY_ZULIP_EMAIL` / `PARLEY_ZULIP_API_KEY` to also run the
gated `zulip (real)` suite. Discord, Telegram, and Slack are hosted SaaS — nothing to compose;
their suites likewise run against in-process fakes, with manual real-service runs documented in
each plugin README.

## Keycloak (post-v1 external-OIDC auth mode) — ready to run

`quay.io/keycloak/keycloak:26.3` in `start-dev` mode on `localhost:8080`, auto-importing the
throwaway **`parley` realm** from `keycloak/parley-realm.json`:

- users `parley` / `parleypass` (has the `parley-owner` realm role) and `stranger` / `parleypass`
  (doesn't);
- client scope `parley-aud` with an **audience mapper** injecting `aud: parley-mcp` — Keycloak
  ignores RFC 8707 `resource` parameters, so the audience must be mapped (this is the same setup
  a production realm needs; see `docs/keycloak-integration.md`);
- public client `parley-test` with direct-access grants, used by the gated test to mint tokens.

The gated suite `packages/bridge-core/src/auth/keycloak.e2e.test.ts` probes
`http://127.0.0.1:8080/realms/parley` (override with `PARLEY_KEYCLOAK_URL`) and self-skips when
the realm isn't up. Admin console: `admin` / `admin`.

JSON can't carry comments, so one note that belongs in the realm file lives here instead: the
import intentionally does **not** configure client-registration (DCR) trusted-hosts policies —
that's admin-console work a real deployment needs for Claude's connector to register itself, and
it is documented step by step in `docs/keycloak-integration.md`.

> These compose services were authored from upstream conventions; Synapse and Prosody in
> particular are validated against the conformance suite when their plugins are implemented.
