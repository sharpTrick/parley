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

cp -al "$root/node_modules" "$dir/node_modules"

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
