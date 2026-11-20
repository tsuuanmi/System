#!/bin/sh
# Item ir-2: the `core-budget` check. The active core is the lines of the .ts files under packages/work/src and packages/artifacts/src.
# Rule: the core may not grow against $SYSTEM_CHECK_BASE (the Work's base, never an absolute number) unless the change adds a line
# to PLAN.md §2 of the form `core +<delta>: <reason>` (the delta being the growth printed here). Without a base, it passes.
set -u

base=${SYSTEM_CHECK_BASE:-}
if [ -z "$base" ]; then
  echo "core-budget: SYSTEM_CHECK_BASE is unset, nothing to compare with; passing"
  exit 0
fi

dirs="packages/work/src packages/artifacts/src"
# Total lines of the core's .ts files at a commit, read with git (no checkout).
count() {
  git ls-tree -r --name-only "$1" -- $dirs | grep '\.ts$' | while IFS= read -r f; do git show "$1:$f"; done | wc -l | tr -d ' '
}
# PLAN.md §2 at a commit, one line per line.
section2() { git show "$1:PLAN.md" 2>/dev/null | awk '/^## /{on = ($0 ~ /^## 2[. ]/)} on'; }

before=$(count "$base")
after=$(count HEAD)
if [ "$after" -le "$before" ]; then
  echo "core-budget: core $before -> $after lines against $base: not grown"
  exit 0
fi
delta=$((after - before))

# Lines of §2 at HEAD that the base did not have; one must name this delta with a reason.
old=$(mktemp)
trap 'rm -f "$old"' EXIT
section2 "$base" > "$old"
if section2 HEAD | grep -vxF -f "$old" | grep -Eq "core \+$delta[^0-9,][^[:alnum:]]*[[:alnum:]]"; then
  echo "core-budget: core $before -> $after lines (+$delta), named in PLAN.md §2"
  exit 0
fi
echo "core-budget: the active core grew from $before to $after lines against $base (+$delta); add a line \`core +$delta: <reason>\` to PLAN.md §2, or remove the growth" >&2
exit 1
