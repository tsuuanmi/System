#!/bin/sh
# A stand-in for `agy` under the layer (sandbox.test.ts): it prints the Node that is first on its PATH and whether it can list the passwd home's .ssh,
# as an agy result event. agy's own `--sandbox` is what would hide the toolchain; the fake has none, the layer is the only boundary.
. "$(dirname "$0")/probe.conf"
v=$(node -v 2>/dev/null)
ls "$HOME_DIR/.ssh" >/dev/null 2>&1 && s=listed || s=denied
printf '{"event":"result","result":{"status":"SUCCESS","response":"{\\"status\\":\\"done\\",\\"reason\\":\\"node=%s;ssh=%s;\\"}","usage":{"input_tokens":1,"output_tokens":1}}}\n' "$v" "$s"
