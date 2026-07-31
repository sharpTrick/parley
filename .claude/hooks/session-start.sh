#!/bin/bash
# Restores a Parley web session's environment, and — first — checks whether the container
# silently rolled back to an older snapshot.
#
# The rollback is not preventable from inside the container, and it is not what causes damage:
# every commit that had been pushed survived one intact. What causes damage is not NOTICING, and
# then reasoning from a stale tree. That has happened twice: once concluding four rounds of work
# were lost when they were safe on the remote, and once when a review agent analysed a tree seven
# rounds out of date. Both times every local instrument agreed with itself, because a rolled-back
# filesystem is internally consistent. `git ls-remote` is the only instrument that can refute it,
# so this runs it before anything else looks at the tree.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

say() { printf '[parley-session-start] %s\n' "$*"; }

# ---------------------------------------------------------------- rollback detection
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)
if [ "$branch" != "HEAD" ] && git remote get-url origin >/dev/null 2>&1; then
  fetched=0
  for wait in 2 4 8 16; do
    if git fetch --quiet origin "$branch" 2>/dev/null; then fetched=1; break; fi
    sleep "$wait"
  done

  if [ "$fetched" -eq 0 ]; then
    say "WARNING: could not reach origin. Cannot rule out a container rollback — verify with"
    say "         'git ls-remote origin $branch' before trusting this tree."
  else
    local_head=$(git rev-parse HEAD)
    remote_head=$(git rev-parse FETCH_HEAD)
    if [ "$local_head" = "$remote_head" ]; then
      say "in sync with origin/$branch at ${local_head:0:7}"
    elif git merge-base --is-ancestor "$local_head" "$remote_head" 2>/dev/null; then
      # Local is strictly BEHIND a branch this session is supposed to own. Nothing here pushes to
      # this branch except this session, so the remote cannot legitimately be ahead — this is the
      # rollback signature.
      say "ROLLBACK DETECTED: local ${local_head:0:7} is behind origin/$branch ${remote_head:0:7}"
      say "  $(git rev-list --count "$local_head".."$remote_head") commit(s) on the remote are missing locally."
      # Tracked modifications only: `git reset --hard` never removes untracked files, so counting
      # them here would refuse the recovery over a stray build artifact that is not at risk.
      if [ -z "$(git status --porcelain --untracked-files=no)" ]; then
        git reset --hard "$remote_head" >/dev/null 2>&1 &&
          say "  working tree was clean; reset to ${remote_head:0:7}. Nothing lost." ||
          say "  RESET FAILED — do not trust this tree; recover manually."
      else
        # Keep the reset OFF the dirty path, so that a rollback recovery can never be the thing
        # that discards real uncommitted work.
        say "  working tree is DIRTY — not resetting automatically."
        say "  Inspect 'git status', preserve anything real, then:"
        say "    git fetch origin $branch && git reset --hard origin/$branch"
      fi
    elif git merge-base --is-ancestor "$remote_head" "$local_head" 2>/dev/null; then
      say "local is ahead of origin/$branch by $(git rev-list --count "$remote_head".."$local_head") commit(s) — push when ready"
    else
      say "WARNING: local and origin/$branch have DIVERGED. Not touching the tree; resolve by hand."
    fi
  fi
fi

# ---------------------------------------------------------------- dependencies
if [ -f package.json ]; then
  say "installing dependencies"
  npm install --no-audit --no-fund >/dev/null 2>&1 &&
    say "dependencies ready" ||
    say "WARNING: npm install failed — run it by hand and read the output"
fi

# ---------------------------------------------------------------- dev services
# The suites do not skip when a server is missing; they FAIL, deliberately (a suite that skips
# itself into a green run is the defect this repo has a lens for). So a session that starts
# without these looks like a broken test suite rather than a missing container.
if [ -x examples/dev-compose/dev-infra.sh ] && command -v docker >/dev/null 2>&1; then
  if ! timeout 10 docker info >/dev/null 2>&1; then
    say "docker daemon is down; starting it"
    if command -v sudo >/dev/null 2>&1; then
      (sudo dockerd >/tmp/parley-dockerd.log 2>&1 &)
    else
      (dockerd >/tmp/parley-dockerd.log 2>&1 &)
    fi
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      timeout 5 docker info >/dev/null 2>&1 && break
      sleep 2
    done
  fi

  if timeout 10 docker info >/dev/null 2>&1; then
    say "bringing up dev services (redis, nats, postgres, prosody, synapse, keycloak)"
    if timeout 900 ./examples/dev-compose/dev-infra.sh up all >/tmp/parley-dev-infra.log 2>&1; then
      say "dev services ready"
    else
      say "WARNING: dev-infra did not come up cleanly — see /tmp/parley-dev-infra.log"
      say "         Suites needing a server will FAIL rather than skip; that is by design."
    fi
  else
    say "WARNING: docker unavailable — server-backed suites will fail until it is running"
  fi
fi

exit 0
