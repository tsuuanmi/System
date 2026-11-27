#!/bin/sh
# The scheduled session (PLAN SS, section 1, ss-8, ss-9): `claude -p` with tools/night-session.md and exactly the tools it uses.
# Started by system-night-session.service; the allowlist and the prompt are checked against each other by
# packages/bundle/tests/night-session-units.test.ts. Nothing here approves, denies, cancels, retries or releases.
# `claude -p` alone runs inside a bubblewrap layer with only the caller socket (ADR-0016 decision 5; docs/operations/scheduled-session.md).
# The layer is built here, not by packages/agents/src/adapters/sandbox.ts: that builds an attempt's layer in TypeScript from an attempt
# Workspace (its own directory and git data read-write), and calling it from this script would need a new Node entry point for an
# argv that shares only the first lines (hide the home and the Host state, keep the network).
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
# Runs the argv in "$@" inside the layer. When the layer cannot start, layer_error says why and nothing runs. Hidden: the passwd home (so ~/.ssh), and all of $DSH_HOME/system but its caller socket
# (so no operator/, state.sqlite or Account homes). Bound read-only: the night's repositories (and their git data), this checkout, the
# installed `system` and `claude`, the PATH directories, Claude Code's configuration. Bound read-write: a temporary directory, and what
# Claude Code writes (~/.claude.json and, of ~/.claude, only projects, session-env, sessions, shell-snapshots, todos, .credentials.json).
layer_error=
in_layer() {
  bwrap=$(command -v bwrap) || { layer_error="the sandbox layer cannot start: bwrap is not on the PATH"; return 1; }
  "$bwrap" --ro-bind / / --dev /dev --proc /proc --unshare-pid --die-with-parent true >/dev/null 2>&1 \
    || { layer_error="the sandbox layer cannot start: $bwrap cannot create a user namespace here"; return 1; }
  n=$#
  pw=$(getent passwd "$(id -u)" | cut -d: -f6)
  dsh=${DSH_HOME:-$HOME/.dsh}
  ro="$dir/ro"
  : > "$ro"
  while IFS= read -r line; do
    e=${line#- }
    [ -n "$e" ] || continue
    echo "$e" >> "$ro"
    git -C "$e" rev-parse --path-format=absolute --git-common-dir >> "$ro" 2>/dev/null || true
  done < "$list"
  { echo "$repo"; echo "$HOME/.system"; echo "$HOME/.claude"
    for c in system claude; do
      f=$(command -v "$c") || continue
      r=$(realpath "$f")
      dirname "$f"; dirname "$r"
      # An installed release: bin/system lies in a tree that holds node_modules.
      [ "$(basename "$(dirname "$r")")" = bin ] && dirname "$(dirname "$r")"
    done
    # A PATH directory (and its parent, as nvm's `lib` lies beside `bin`) is bound back only where a hidden home hid it.
    echo "$PATH" | tr : '\n' | while IFS= read -r d; do
      case "$d" in "$pw"/*|"$HOME"/*) echo "$d"; t=$(dirname "$d"); [ "$t" != "$pw" ] && [ "$t" != "$HOME" ] && echo "$t" ;; esac
    done
  } >> "$ro" 2>/dev/null || true
  mkdir -p "$dir/tmp"
  set -- "$@" "$bwrap" --die-with-parent --unshare-pid --ro-bind / / --dev /dev --proc /proc
  [ -d "$pw" ] && [ "$pw" != / ] && set -- "$@" --tmpfs "$pw"
  [ -d "$dsh/system" ] && set -- "$@" --tmpfs "$dsh/system"
  [ -S "$dsh/system/host.sock" ] && set -- "$@" --bind "$dsh/system/host.sock" "$dsh/system/host.sock"
  while IFS= read -r p; do
    [ -e "$p" ] && set -- "$@" --ro-bind "$p" "$p"
  done < "$ro"
  # Claude Code writes these; a hook or setting in ~/.claude stays unwritable. A path that is not there is not bound.
  for w in "$HOME/.claude.json" "$HOME/.claude/.credentials.json" "$HOME/.claude/projects" "$HOME/.claude/session-env" "$HOME/.claude/sessions" "$HOME/.claude/shell-snapshots" "$HOME/.claude/todos"; do
    [ -e "$w" ] && set -- "$@" --bind "$w" "$w"
  done
  set -- "$@" --bind "$dir/tmp" "$dir/tmp" --setenv TMPDIR "$dir/tmp" --
  # The original argv is the first n words: move it behind the layer.
  i=0
  while [ "$i" -lt "$n" ]; do set -- "$@" "$1"; shift; i=$((i + 1)); done
  "$@"
}

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
in_layer claude -p "$prompt" --output-format text --allowedTools "$@" > "$dir/answer" || code=$?

# An empty answer or a failed claude still leaves a short report saying so.
if [ -n "$layer_error" ]; then
  # Fail closed: no `claude` ran.
  { echo "# Night report"; echo; echo "The scheduled session did not run: the layer could not start, so \`claude\` was not run."; echo; echo "$layer_error"; } > "$dir/report.md"
  code=1
elif [ "$code" -ne 0 ]; then
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
