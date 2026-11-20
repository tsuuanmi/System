#!/bin/sh
# Item ir-2: the `core-budget` check. The active core is the lines of the .ts files under packages/work/src and packages/artifacts/src.
# Rule: the core may not grow against the base (never an absolute number) unless the `core +<delta>: <reason>` lines the change adds to
# PLAN.md §2 (against that same base) sum to at least the growth printed here. Without a base, it passes.
# The base is $SYSTEM_CHECK_BASE (the Work's admission base), except when HEAD is a merge commit (the merge re-check): then it is HEAD's
# first parent, the tip the merge goes into, so what other changes merged meanwhile (and justified themselves) is not charged to this one.
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

if git rev-parse -q --verify "HEAD^2" >/dev/null 2>&1; then base=$(git rev-parse "HEAD^1"); fi

before=$(count "$base")
after=$(count HEAD)
if [ "$after" -le "$before" ]; then
  echo "core-budget: core $before -> $after lines against $base: not grown"
  exit 0
fi
delta=$((after - before))

# Lines of §2 at HEAD that the base did not have; their `core +<n>: <reason>` markers must sum to at least this growth.
old=$(mktemp)
trap 'rm -f "$old"' EXIT
section2 "$base" > "$old"
named=$(section2 HEAD | grep -vxF -f "$old" | grep -Eo 'core \+[0-9]+[^0-9,][^[:alnum:]]*[[:alnum:]]' | sed -E 's/^core \+([0-9]+).*/\1/' | awk '{s += $1} END {print s + 0}')
if [ "$named" -ge "$delta" ]; then
  echo "core-budget: core $before -> $after lines (+$delta), named in PLAN.md §2 (+$named)"
  exit 0
fi
echo "core-budget: the active core grew from $before to $after lines against $base (+$delta); PLAN.md §2 names +$named; add \`core +<delta>: <reason>\` lines summing to at least +$delta to PLAN.md §2, or remove the growth" >&2
exit 1
