#!/bin/bash
# Answers one question: is this working tree current, or is it a rolled-back snapshot?
#
# The container is reprovisioned from a snapshot, and a stale one is INTERNALLY CONSISTENT —
# HEAD, the reflog, `git cat-file` and the remote-TRACKING ref all agree with each other, because
# a remote-tracking ref is just a file under .git/refs/remotes/ that rolled back too. Every local
# instrument corroborates every other one and they are all wrong together. `git ls-remote` is the
# only instrument that can refute it, so this asks the remote and nothing else.
#
# The predicate is "does this repo contain the remote's tip", not "is HEAD equal to it" — being
# AHEAD of the remote is the normal state with unpushed work and must not alarm. Losing a commit
# the remote has is not a state honest work can reach on a branch only this session pushes to.
#
#   scripts/verify-fresh.sh              # against the current branch
#   scripts/verify-fresh.sh <expected>   # also assert HEAD is <expected> (for a pinned worktree)
#
# Exit 0 fresh · 1 STALE · 2 cannot tell (remote unreachable — which is not a pass).
set -uo pipefail

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)
expected="${1:-}"

if [ -n "$expected" ]; then
  head=$(git rev-parse HEAD)
  case "$head" in
    "$expected"*) : ;;
    *)
      echo "STALE: HEAD is ${head:0:12}, expected ${expected:0:12}."
      echo "This worktree is not the tree you were briefed on. Stop and report the mismatch"
      echo "rather than analysing it — findings against the wrong tree cost more than no findings."
      exit 1
      ;;
  esac
fi

if [ "$branch" = "HEAD" ]; then
  # A detached worktree has no branch to compare; the pinned-SHA check above is its whole guard.
  echo "fresh: detached at $(git rev-parse --short HEAD)${expected:+ (matches the pin)}"
  exit 0
fi

remote=$(git ls-remote origin "$branch" 2>/dev/null | cut -f1)
if [ -z "$remote" ]; then
  echo "UNKNOWN: cannot reach origin, so staleness cannot be ruled out."
  echo "Do not treat this as a pass — no local check can substitute for the remote here."
  exit 2
fi

if git cat-file -e "${remote}^{commit}" 2>/dev/null; then
  echo "fresh: repo contains origin/${branch} tip ${remote:0:12}"
  exit 0
fi

echo "STALE: this repo does not contain origin/${branch} tip ${remote:0:12}."
echo "The container rolled back. Recover before reading anything else:"
echo "  git fetch origin ${branch} && git reset --hard origin/${branch}"
echo "(check 'git status --porcelain --untracked-files=no' first — reset discards tracked edits)"
exit 1
