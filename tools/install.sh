#!/usr/bin/env bash
# The one script of a new machine (runbook, install-and-update.md "Install and start", Item install-1): from a clone of System, build the install
# `system update` would leave (`$SYSTEM_INSTALL`, default ~/.system: release/, releases/<commit>/, current) for the commit this
# clone has checked out, and write the profile with `system init`. It never enables or starts the Host. Needs git, corepack and
# Node >=24.9 (an older Node on PATH is replaced by the newest Node 24 under ~/.nvm, as bin/system does).
# Set INSTALL_WEB=1 to also require Xvfb (the web Worker only).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
install=${SYSTEM_INSTALL:-$HOME/.system}
fail() { echo "install: $*" >&2; exit 1; }

command -v git >/dev/null || fail "git is not installed: install it with your package manager"
git -C "$root" rev-parse --git-dir >/dev/null 2>&1 || fail "$root is not a git clone: run \`git clone <origin> && cd System\` first"
commit=$(git -C "$root" rev-parse HEAD)

# Node >=24.9: the one on PATH, else the newest 24 under ~/.nvm (service.mjs does the same at run time).
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=9)?0:1)' 2>/dev/null; }
node=$(command -v node || true)
if [ -z "$node" ] || ! node_ok "$node"; then
  node=""
  for candidate in $(ls -d "$HOME"/.nvm/versions/node/v24.*/bin/node 2>/dev/null | sort -V -r); do
    if node_ok "$candidate"; then node=$candidate; break; fi
  done
fi
[ -n "$node" ] || fail "Node >=24.9 is required: run \`nvm install 24\` (https://github.com/nvm-sh/nvm), then run this again"
export PATH="$(dirname "$node"):$PATH"
command -v corepack >/dev/null || fail "corepack not found beside $node: run \`nvm install 24\` or \`npm install -g corepack\`"
if [ "${INSTALL_WEB:-}" = 1 ]; then command -v Xvfb >/dev/null || fail "Xvfb is required for the web Worker: install the xvfb package"; fi

release="$install/releases/$commit"
mkdir -p "$install/releases"
if [ ! -d "$install/source/.git" ] && [ ! -f "$install/source/HEAD" ]; then
  origin=$(git -C "$root" remote get-url origin 2>/dev/null || echo "$root")
  git clone --quiet --no-checkout "$origin" "$install/source"
fi
# The commit may be one origin does not have (a branch not pushed yet): take it from this clone.
git -C "$install/source" cat-file -e "$commit^{commit}" 2>/dev/null || git -C "$install/source" fetch --quiet "$root" "$commit"
[ -d "$release" ] || git -C "$install/source" worktree add --quiet --detach "$release" "$commit"
echo "install: building $commit in $release"
(cd "$release" && corepack pnpm install --frozen-lockfile && corepack pnpm build)
ln -sfn "releases/$commit" "$install/current.new" && mv -T "$install/current.new" "$install/current"
"$node" "$install/current/bin/system" init
echo "install: done. Put $install/current/bin/system on PATH as \`system\`, then run: systemctl --user enable --now system"
