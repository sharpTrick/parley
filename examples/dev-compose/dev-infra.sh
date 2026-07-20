#!/usr/bin/env bash
# dev-infra.sh — one-command throwaway servers for the Parley conformance suites (DESIGN §15).
#
# NOT production. Stands up a disposable backend, seeds the test account the conformance factory
# expects (user `parley`, password `parleypass`), and optionally runs that backend's suite. Every
# step is idempotent, so re-running is safe.
#
#   ./dev-infra.sh up   <backend>   # start + wait healthy + seed the test user
#   ./dev-infra.sh test <backend>   # up, then run packages/bridge-<backend>'s conformance suite
#   ./dev-infra.sh logs <backend>   # tail the server logs
#   ./dev-infra.sh down             # stop & remove everything (incl. volumes)
#
#   backend ∈ { redis, nats, postgres, xmpp, matrix, all }   (all: every backend above)
#
# Requires a running Docker daemon + `docker compose`. The suites self-detect the server at its
# default localhost URL (override with the PARLEY_* env vars — see README.md), so no wiring needed.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
COMPOSE=(docker compose -f "$DIR/docker-compose.yml")
BACKENDS=(redis nats postgres xmpp matrix)

log() { printf '\033[1;36m[dev-infra]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[dev-infra] %s\033[0m\n' "$*" >&2; exit 1; }

# Poll `cmd` until it succeeds or `secs` elapse.
wait_for() { # <secs> <label> <cmd...>
  local secs="$1" label="$2"; shift 2
  for ((i = 0; i < secs; i++)); do
    if "$@" >/dev/null 2>&1; then log "$label ready"; return 0; fi
    sleep 1
  done
  die "$label did not become ready within ${secs}s"
}

up_redis()    { "${COMPOSE[@]}" up -d redis;    wait_for 30 redis    "${COMPOSE[@]}" exec -T redis redis-cli ping; }
up_nats()     { "${COMPOSE[@]}" up -d nats;     wait_for 30 nats     "${COMPOSE[@]}" exec -T nats wget -qO- http://localhost:8222/healthz; }
up_postgres() { "${COMPOSE[@]}" up -d postgres; wait_for 30 postgres "${COMPOSE[@]}" exec -T postgres pg_isready -U parley; }

up_xmpp() {
  "${COMPOSE[@]}" up -d prosody
  # Gate on the c2s port from the host (prosody has no pidfile, so `prosodyctl status` is unreliable;
  # host bash has /dev/tcp, the dash in the container does not).
  wait_for 30 prosody bash -c 'exec 3<>/dev/tcp/127.0.0.1/5222'
  # Seed the test account (idempotent: a duplicate register just errors, which we ignore).
  "${COMPOSE[@]}" exec -T prosody prosodyctl register parley parley.local parleypass 2>/dev/null \
    && log "registered xmpp user parley@parley.local" \
    || log "xmpp user parley@parley.local already present"
}

up_matrix() {
  local ov="/dev-overrides.yaml"
  # 1. Generate the base config once (idempotent — skips if homeserver.yaml already exists).
  if ! "${COMPOSE[@]}" run --rm --no-deps --entrypoint sh synapse -c '[ -f /data/homeserver.yaml ]'; then
    log "generating synapse config"
    "${COMPOSE[@]}" run --rm --no-deps \
      -e SYNAPSE_SERVER_NAME=parley.local -e SYNAPSE_REPORT_STATS=no \
      --entrypoint /start.py synapse generate
  fi
  # 2. Pin the 8008 listener to IPv4 (containers without IPv6 die on the generated '::' bind). In
  #    place, because a second `listeners:` block would be a duplicate top-level key.
  "${COMPOSE[@]}" run --rm --no-deps --entrypoint sh synapse -c \
    'grep -q "bind_addresses:" /data/homeserver.yaml || sed -i "/^  - port: 8008/a\    bind_addresses: [\"0.0.0.0\"]" /data/homeserver.yaml'
  # 3. Append the dev overrides (relaxed rate limits) once — keyed on the sentinel line in the file,
  #    because `synapse generate` already emits registration_shared_secret (used by register below).
  "${COMPOSE[@]}" run --rm --no-deps --entrypoint sh synapse -c \
    "grep -q 'parley dev-overrides' /data/homeserver.yaml || cat $ov >> /data/homeserver.yaml"
  # 4. Start it and wait for the client API.
  "${COMPOSE[@]}" up -d synapse
  wait_for 90 synapse "${COMPOSE[@]}" exec -T synapse \
    python -c 'import urllib.request; urllib.request.urlopen("http://localhost:8008/health", timeout=3)'
  # 5. Seed the test account (idempotent: re-register of an existing user just errors).
  "${COMPOSE[@]}" exec -T synapse register_new_matrix_user \
    -u parley -p parleypass -a -c /data/homeserver.yaml http://localhost:8008 2>/dev/null \
    && log "registered matrix user @parley:parley.local" \
    || log "matrix user @parley:parley.local already present"
}

up_one() {
  case "$1" in
    redis) up_redis ;; nats) up_nats ;; postgres) up_postgres ;;
    xmpp) up_xmpp ;; matrix) up_matrix ;;
    *) die "unknown backend '$1' (expected: ${BACKENDS[*]} all)" ;;
  esac
}

expand() { [[ "$1" == "all" ]] && printf '%s\n' "${BACKENDS[@]}" || printf '%s\n' "$1"; }

cmd_up()   { for b in $(expand "$1"); do log "bringing up $b"; up_one "$b"; done; }
cmd_test() {
  for b in $(expand "$1"); do
    up_one "$b"
    log "running conformance: packages/bridge-$b"
    ( cd "$REPO" && npx vitest run "packages/bridge-$b" )
  done
}
cmd_logs() { "${COMPOSE[@]}" logs -f "$(svc_of "$1")"; }
cmd_down() { log "tearing down all services + volumes"; "${COMPOSE[@]}" down -v; }

# Compose service name for a backend (xmpp→prosody, matrix→synapse; others match).
svc_of() { case "$1" in xmpp) echo prosody ;; matrix) echo synapse ;; *) echo "$1" ;; esac; }

main() {
  local action="${1:-}" backend="${2:-}"
  command -v docker >/dev/null || die "docker not found"
  docker info >/dev/null 2>&1 || die "docker daemon not reachable — start it first"
  case "$action" in
    up)   [[ -n "$backend" ]] || die "usage: $0 up <backend|all>";   cmd_up "$backend" ;;
    test) [[ -n "$backend" ]] || die "usage: $0 test <backend|all>"; cmd_test "$backend" ;;
    logs) [[ -n "$backend" ]] || die "usage: $0 logs <backend>";     cmd_logs "$backend" ;;
    down) cmd_down ;;
    *) die "usage: $0 <up|test|logs|down> [backend]   backend ∈ ${BACKENDS[*]} all" ;;
  esac
}

main "$@"
