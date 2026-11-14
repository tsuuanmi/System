#!/bin/sh
# The scheduled session (PLAN 3c, ss-8, ss-9): `claude -p` with tools/night-session.md and exactly the tools it uses.
# Started by system-night-session.service; the allowlist and the prompt are checked against each other by
# packages/bundle/tests/night-session-units.test.ts. Nothing here approves, denies, cancels, retries or releases.
# The session's final answer is the night report (Markdown); this launcher stores it as an Artifact, prints its ID
# and sends the ID to SYSTEM_NIGHT_NOTIFY_URL (curl) or as $1 to SYSTEM_NIGHT_NOTIFY_COMMAND, when set.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
prompt=$(cat "$repo/tools/night-session.md")
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
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
