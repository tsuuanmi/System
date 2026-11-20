#!/bin/sh
# The scheduled session (PLAN SS, section 1, ss-8, ss-9): `claude -p` with tools/night-session.md and exactly the tools it uses.
# Started by system-night-session.service; the allowlist and the prompt are checked against each other by
# packages/bundle/tests/night-session-units.test.ts. Nothing here approves, denies, cancels, retries or releases.
# The session's final answer is the night report (Markdown); this launcher stores it as an Artifact, prints its ID
# and sends the ID to SYSTEM_NIGHT_NOTIFY_URL (curl) or as $1 to SYSTEM_NIGHT_NOTIFY_COMMAND, when set.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

# The repositories the session works on: SYSTEM_NIGHT_REPOS (paths separated by `:`), else this repository.
# An entry that is not a git checkout is reported (stderr and the prompt, so the night report says so) and skipped.
list="$dir/repos"
skipped="$dir/skipped"
: > "$list"
: > "$skipped"
old_ifs=$IFS
IFS=:
for entry in ${SYSTEM_NIGHT_REPOS:-$repo}; do
  [ -n "$entry" ] || continue
  if git -C "$entry" rev-parse --git-dir >/dev/null 2>&1; then
    echo "- $entry" >> "$list"
  else
    echo "$entry: not a git checkout, skipped" >&2
    echo "Skipped, not a git checkout: $entry" >> "$skipped"
  fi
done
IFS=$old_ifs
# Every repository the session works on gets a fresh `origin/dev` before the prompt (explicit refspec: an origin that
# fetches only main would not update it). A failure is logged and the night goes on with the ref it has.
while IFS= read -r line; do
  entry=${line#- }
  [ -n "$entry" ] || continue
  if command -v timeout >/dev/null 2>&1; then fetch="timeout 60 git"; else fetch="git"; fi
  $fetch -C "$entry" fetch --quiet origin +refs/heads/dev:refs/remotes/origin/dev </dev/null || echo "$entry: fetch of origin dev failed; the session reads the origin/dev it has" >&2
done < "$list"
# The start time is taken here, by the launcher, so the session never asks the clock (its rules do not allow `date`).
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
prompt=$(cat "$repo/tools/night-session.md"; printf '\nRepositories for this night:\n'; cat "$list"; printf '\nSession started at: %s\n' "$started")
if [ -s "$skipped" ]; then
  prompt=$(printf '%s\n\nSay in the night report that these entries of SYSTEM_NIGHT_REPOS were skipped:\n%s' "$prompt" "$(cat "$skipped")")
fi
set -- \
  mcp__system__status \
  mcp__system__item_claim \
  mcp__system__task_new \
  mcp__system__work_submit \
  mcp__system__work_show \
  mcp__system__work_report \
  mcp__system__work_list \
  mcp__system__artifact_show \
  mcp__system__artifact_cat \
  'Bash(system work wait:*)'

code=0
claude -p "$prompt" --output-format text --allowedTools "$@" > "$dir/answer" || code=$?

# An empty answer or a failed claude still leaves a short report saying so.
if [ "$code" -ne 0 ]; then
  { echo "# Night report"; echo; echo "The scheduled session failed: \`claude\` exited with status $code."
    if grep -q '[^[:space:]]' "$dir/answer"; then echo; echo "What it had written:"; echo; cat "$dir/answer"; fi
  } > "$dir/report.md"
elif ! grep -q '[^[:space:]]' "$dir/answer"; then
  printf '# Night report\n\nThe scheduled session ended with an empty answer: there is no report.\n' > "$dir/report.md"
else
  mv "$dir/answer" "$dir/report.md"
fi

id=$(system artifact put "$dir/report.md" --media-type text/markdown)
echo "$id"

if [ -n "${SYSTEM_NIGHT_NOTIFY_URL:-}" ]; then
  curl -fsS -d "$id" "$SYSTEM_NIGHT_NOTIFY_URL" || echo "the notifier URL failed; the night is not failed by it" >&2
fi
if [ -n "${SYSTEM_NIGHT_NOTIFY_COMMAND:-}" ]; then
  sh -c "$SYSTEM_NIGHT_NOTIFY_COMMAND" -- "$id" || echo "the notifier command failed; the night is not failed by it" >&2
fi
exit "$code"
