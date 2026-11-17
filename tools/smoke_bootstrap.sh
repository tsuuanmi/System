#!/usr/bin/env bash
# Portable-bootstrap smoke test; called by .github/workflows/docs.yml and the `docs` check in .system/checks.yaml.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
b=(python3 tools/bootstrap_docs.py --out "$tmp/independent" --name "Independent Example")
"${b[@]}" --plan
"${b[@]}"
(cd "$tmp/independent" && python3 tools/docs.py check && python3 tools/docs.py sync --check)
"${b[@]}"
"${b[@]}" --plan
test -z "$("${b[@]}" --plan | grep -v '^unchanged ')"
