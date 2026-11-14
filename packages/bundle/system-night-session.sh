#!/bin/sh
# The scheduled session (PLAN 3c, ss-8): `claude -p` with tools/night-session.md and exactly the tools it uses.
# Started by system-night-session.service; the allowlist and the prompt are checked against each other by
# packages/bundle/tests/night-session-units.test.ts. Nothing here approves, denies, cancels, retries or releases.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
set -- \
  mcp__system__status \
  mcp__system__item_claim \
  mcp__system__task_new \
  mcp__system__work_submit \
  mcp__system__work_show \
  mcp__system__work_report \
  mcp__system__work_list \
  mcp__system__artifact_put \
  mcp__system__artifact_show \
  mcp__system__artifact_cat \
  'Bash(system work wait:*)' \
  'Bash([ -n "${SYSTEM_NIGHT_NOTIFY_URL:-}" ])' \
  'Bash([ -n "${SYSTEM_NIGHT_NOTIFY_COMMAND:-}" ])'
# The notifier, only when the operator configured it (the prompt's own lines, with the variables unexpanded).
if [ -n "${SYSTEM_NIGHT_NOTIFY_URL:-}" ]; then
  set -- "$@" 'Bash(curl -fsS -d * "$SYSTEM_NIGHT_NOTIFY_URL")'
fi
if [ -n "${SYSTEM_NIGHT_NOTIFY_COMMAND:-}" ]; then
  set -- "$@" 'Bash(sh -c "$SYSTEM_NIGHT_NOTIFY_COMMAND" -- *)'
fi
exec claude -p "$(cat "$repo/tools/night-session.md")" --allowedTools "$@"
