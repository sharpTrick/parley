#!/bin/bash
# Create a review/remediation worktree that is HERMETIC — one whose cross-package imports resolve
# to its OWN packages rather than to the main checkout's.
#
#   scripts/careening-worktree.sh <dir> <base-sha>
#
# Symlinking node_modules at the main checkout is the obvious way to avoid fifteen copies of one
# dependency tree, and it is wrong in a way that stays silent: npm workspaces put ABSOLUTE symlinks
# at node_modules/@sharptrick/*, so a worktree resolves every sibling package to
# /home/user/parley/packages/*. An agent editing two packages sees only one of its own edits, and
# `tsc -b` reports errors that belong to a tree it is not working in — which is exactly how a
# round-13 agent came to report a repo-wide typecheck failure that does not exist.
#
# Hard-linking costs no disk (the files share inodes), gives a REAL directory, and lets the
# workspace links be re-pointed at this worktree.
set -euo pipefail

dir="${1:?usage: careening-worktree.sh <dir> <base-sha>}"
base="${2:?usage: careening-worktree.sh <dir> <base-sha>}"
root=$(git rev-parse --show-toplevel)

rm -rf "$dir"
git worktree prune
git worktree add --detach -q "$dir" "$base"

# Hard links cannot cross filesystems. /tmp is tmpfs on a normal desktop while the checkout is on
# the home volume, so a worktree base under /tmp fails here with EXDEV even though it worked on the
# single-filesystem cloud container this was written on. Say so, rather than leaving the operator to
# read `cp: Invalid cross-device link` and guess.
if ! cp -al "$root/node_modules" "$dir/node_modules" 2>/dev/null; then
  rm -rf "$dir/node_modules"
  echo "REFUSING: cannot hard-link node_modules from $root into $dir." >&2
  echo "  They are on different filesystems ($(df -P "$root" | awk 'NR==2{print $1}') vs $(df -P "$(dirname "$dir")" | awk 'NR==2{print $1}'))." >&2
  echo "  Hard links are what make a worktree cost no disk; copying fifteen dependency trees is not the fallback." >&2
  echo "  Set CAREENING_WORKTREES to a path on the same filesystem as the checkout, e.g.:" >&2
  echo "    export CAREENING_WORKTREES=\"$(dirname "$root")/.careening/worktrees\"" >&2
  git worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
  exit 1
fi

# Re-point every workspace link at THIS worktree, so that a cross-package edit is visible to the
# typecheck that is supposed to catch it.
if [ -d "$dir/node_modules/@sharptrick" ]; then
  for link in "$dir"/node_modules/@sharptrick/*; do
    [ -e "$link" ] || continue
    target=$(readlink -f "$link" 2>/dev/null || true)
    case "$target" in
      "$root"/packages/*)
        rm -rf "$link"
        ln -s "$dir/packages/${target#"$root"/packages/}" "$link"
        ;;
    esac
  done
fi

echo "worktree $dir @ $(git -C "$dir" rev-parse --short HEAD), $(ls -1 "$dir"/node_modules/@sharptrick 2>/dev/null | wc -l) workspace links re-pointed"
