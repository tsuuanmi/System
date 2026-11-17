#!/bin/sh
# Item rb-5: the `secrets` check. Runs gitleaks on what the change adds to its base (the commits `<base>..HEAD`), never on the
# whole history. A finding is reported with its file and rule; `--redact` keeps the value out of the output.
# The verifier gives checks a throwaway HOME, so ~/.local/bin is not on PATH there; the binary is looked up by, in order:
# $GITLEAKS_BIN, PATH, the operator's real home (from the password database). A machine without it fails closed.
# $SYSTEM_CHECK_BASE is the commit the checks were pinned from (set by the verifier); without it, the merge base with origin/dev.
set -u

bin=${GITLEAKS_BIN:-}
if [ -z "$bin" ]; then
  bin=$(command -v gitleaks 2>/dev/null || true)
fi
if [ -z "$bin" ] && [ -z "${SYSTEM_GITLEAKS_NONE:-}" ]; then
  real=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)
  [ -n "$real" ] && [ -x "$real/.local/bin/gitleaks" ] && bin=$real/.local/bin/gitleaks
fi
if [ -z "$bin" ] || [ ! -x "$bin" ]; then
  echo "secrets: gitleaks not found (${GITLEAKS_BIN:-not on PATH or in ~/.local/bin}); install gitleaks: download the release and verify its checksum, see docs/operations/runbook.md (Install gitleaks), then put it on PATH or set GITLEAKS_BIN" >&2
  exit 1
fi

base=${SYSTEM_CHECK_BASE:-}
[ -n "$base" ] || base=$(git merge-base HEAD origin/dev 2>/dev/null || true)
if [ -z "$base" ]; then
  echo "secrets: no base to compare with (SYSTEM_CHECK_BASE is unset and there is no origin/dev)" >&2
  exit 1
fi

out=$("$bin" git --redact --no-banner --no-color -v -l warn --log-opts "$base..HEAD" . 2>&1)
status=$?
if [ "$status" -ne 0 ]; then
  printf '%s\n' "$out" | grep -E '^(RuleID|File|Line|Commit):|leaks found|ERR|FTL' >&2
  echo "secrets: gitleaks reported a finding or failed (exit $status) in $base..HEAD" >&2
  exit 1
fi
echo "secrets: no findings in $base..HEAD"
