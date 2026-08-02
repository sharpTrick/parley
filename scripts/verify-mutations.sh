#!/bin/bash
# Replay a remediation agent's claimed mutations and check they actually fail.
#
#   scripts/verify-mutations.sh <manifest.json>
#
# A fixer reports "I watched this test fail against the defect, then restored it." That claim is
# self-reported, and it is the one claim the whole ratchet rests on — a test that passes with and
# without the bug guards nothing. This re-runs it mechanically.
#
# It exists because the check is easy to get wrong in a way that LOOKS right: twice in round 13 a
# mutation regex silently failed to match, the suite ran green against unmutated code, and that
# green read as proof. So this asserts the file CHANGED before it believes a red or a green, which
# is the step a human doing it by hand skips.
#
# Manifest: [{ "file": "...", "find": "...", "replace": "...", "test": "packages/x/test/y.test.ts",
#              "expectFail": "a name fragment, optional" }]
# `find` must be a literal that appears EXACTLY ONCE. Multiple matches are an error, not a guess.
#
# Exit 0 = every mutation applied and reddened its test. Exit 1 = at least one did not.
set -uo pipefail

manifest="${1:?usage: verify-mutations.sh <manifest.json>}"
root=$(git rev-parse --show-toplevel)
cd "$root"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "REFUSING: tracked changes present. Replay mutates files and restores from disk copies;"
  echo "  run it against a tree whose only diff is the remediation you are checking, committed or stashed elsewhere."
  exit 1
fi

total=0; bad=0
count=$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$manifest")

for i in $(seq 0 $((count - 1))); do
  total=$((total + 1))
  read -r file test expectFail < <(python3 - "$manifest" "$i" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))[int(sys.argv[2])]
print(m['file'], m['test'], m.get('expectFail','') or '-')
PY
)
  echo "── [$((i+1))/$count] $file  ->  $test"

  # Apply by literal replacement, and REQUIRE exactly one occurrence. A find string that matches
  # nothing is the silent-no-op this script exists to catch; one that matches twice is ambiguous.
  applied=$(python3 - "$manifest" "$i" <<'PY'
import json,sys,pathlib
m=json.load(open(sys.argv[1]))[int(sys.argv[2])]
p=pathlib.Path(m['file']); t=p.read_text()
n=t.count(m['find'])
if n != 1:
    print(f"NOMATCH:{n}"); raise SystemExit(0)
pathlib.Path(str(p)+'.mutbak').write_text(t)
p.write_text(t.replace(m['find'], m['replace'], 1))
print("OK")
PY
)
  if [ "$applied" != "OK" ]; then
    echo "   FAIL — mutation did not apply cleanly ($applied). The claim cannot be checked, so it is not proven."
    bad=$((bad + 1)); continue
  fi

  if npx vitest run "$test" >/tmp/mutrun.log 2>&1; then
    echo "   FAIL — the suite stayed GREEN under the mutation. This test does not grade the defect."
    bad=$((bad + 1))
  else
    if [ "$expectFail" != "-" ] && ! grep -qF "$expectFail" /tmp/mutrun.log; then
      echo "   FAIL — it went red, but not on '$expectFail'. Something else broke; the named guard is unproven."
      bad=$((bad + 1))
    else
      echo "   ok — red under mutation"
    fi
  fi

  mv "$file.mutbak" "$file"
done

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "REFUSING TO PASS: the tree is dirty after restore — a mutation was not undone."
  git status --porcelain --untracked-files=no
  exit 1
fi

echo "── $((total - bad))/$total mutations reddened their test"
[ "$bad" -eq 0 ] || exit 1
