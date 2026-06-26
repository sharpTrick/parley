# Dev-compose — throwaway infra for testing the network backends

This is the maintainer-facing **"how we test"** harness (DESIGN §15), not a production recipe.
Each network plugin's own README points at the canonical upstream Docker setup; this compose just
stands up disposable instances so the shared conformance suite can run against a real server.

Bring up only what you're working on:

```bash
cd examples/dev-compose
docker compose up redis      # v0.3
docker compose up nats       # v0.5
docker compose up synapse    # v0.4  (see first-run note below)
docker compose up prosody    # v0.5  (MAM enabled in prosody/prosody.cfg.lua)
```

## Redis (v0.3) — ready to run

`redis:7-alpine` on `localhost:6379`. Streams are built in (`XADD`/`XRANGE`/`XREAD BLOCK`). The
plugin's conformance factory will point at `redis://localhost:6379`.

## NATS (v0.5) — ready to run

`nats:2.10-alpine` with JetStream (`-js`) on `localhost:4222` (monitoring on `:8222`). JetStream
sequence numbers are the cursor.

## Synapse / Matrix (v0.4) — one-time config generation

```bash
docker compose run --rm -e SYNAPSE_SERVER_NAME=parley.local -e SYNAPSE_REPORT_STATS=no synapse generate
# then in the generated synapse-data/homeserver.yaml set a registration_shared_secret,
# bring it up, and register a test user:
docker compose up -d synapse
docker compose exec synapse register_new_matrix_user -u parley -p parley -a -c /data/homeserver.yaml http://localhost:8008
```

`server_name=parley.local`, C–S API on `localhost:8008`. Room → topic, sync token → cursor.

## Prosody / XMPP (v0.5) — MAM required

`prosody/prosody:latest` with the mounted `prosody/prosody.cfg.lua` (MAM + a MUC component at
`muc.parley.local`). In-band registration is on for dev; register a test account:

```bash
docker compose exec prosody prosodyctl register parley parley.local parley
```

> These four compose services were authored from upstream conventions; Synapse and Prosody in
> particular are validated against the conformance suite when their plugins are implemented.
