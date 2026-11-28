#!/bin/sh
# A stand-in for a CLI Runtime that probes its own surroundings (sandbox.test.ts); the paths come from probe.conf beside it.
# It prints one stream-json result whose text lists what it could and could not do. It exercises the layer, not a model.
. "$(dirname "$0")/probe.conf"
r=""
add() { r="$r$1;"; }
cat "$STATE/state.sqlite" >/dev/null 2>&1 && add state=read || add state=denied
# a relative path: a socket's path is short, the temporary directories of a test are not
(cd "$STATE" 2>/dev/null && node -e "require('node:net').connect('host.sock').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))") && add socket=connected || add socket=denied
ls "$HOME_DIR/.ssh" >/dev/null 2>&1 && add ssh=listed || add ssh=denied
ls "$HOME_DIR" >/dev/null 2>&1 && [ -n "$(ls -A "$HOME_DIR")" ] && add home=listed || add home=empty
touch "$COMMON/hooks/pre-commit" 2>/dev/null && add hooks=written || add hooks=denied
echo "# x" >> "$COMMON/config" 2>/dev/null && add config=written || add config=denied
echo "# a note" > NOTE.md
git add NOTE.md && git -c user.name=t -c user.email=t@t commit -q -m note && add commit=ok || add commit=failed
echo "require('node:test')('one', () => {})" > one.test.js
node --test one.test.js >/dev/null 2>&1 && add nodetest=ok || add nodetest=failed
curl -s -m 5 -o /dev/null "http://127.0.0.1:$PORT/" && add network=open || add network=closed
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s","structured_output":{"status":"done","reason":"%s"},"usage":{"input_tokens":1,"output_tokens":1}}\n' "$r" "$r"
