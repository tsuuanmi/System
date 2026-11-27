---
type: operations
status: active
reviewed: 2026-11-26
summary: Installing System on a new machine and running its Host as a user service.
covers: [tools/install.sh, bin/system, bin/service.mjs, packages/host/src/process.ts]
---

# Install and update

Part of the [runbook](runbook.md).

## Install and start

**On a new machine**, this page is the whole guide. You need `git`, `corepack`
and Node >=24.9 (`nvm install 24`; add the `xvfb` package only for the web
Worker, with `INSTALL_WEB=1`); [tools/install.sh](../../tools/install.sh) checks
each and says what is missing. Clone, then run the script (the `install-guide`
check runs this block as it is):

```sh
git clone git@github.com:tsuuanmi/System.git && cd System
```

```sh install
tools/install.sh
```

It builds the install below for the commit you cloned and runs `system init`.
Then link `~/.system/current/bin/system` as `system` on `PATH` and enable the
unit (the next paragraphs); `system update` takes it from there.

System runs from an install under `~/.system` (`SYSTEM_INSTALL` for another
place), apart from any checkout you develop in:

```
~/.system/
  source/                        the clone of the origin that releases are built from
  releases/<commit>/             one built install per commit of main; never edit one
  current -> releases/<commit>   the code the Host runs
  profile.yml                    this machine's Accounts and Effects: the Host's --patch
```

The store and the secrets stay in `$DSH_HOME/system` (`~/.dsh`, DSH's).
`system update` installs the newest commit of `main` ([Upgrading](releases.md#upgrading));
`system update --to <release>` switches back to a kept earlier release ([Rollback](releases.md#rollback)).
`system init`, run from the install, links the profile to `current` and writes
the user unit, which it never enables or starts
([bin/README.md](../../bin/README.md)):

```
systemctl --user enable --now system
```

Run `system init` again after changing Node or `PATH` (the unit holds those of
the last init) or adding `profile.yml`. A development checkout runs as itself:
`bin/system host --supervise` with a `DSH_HOME` of its own, never the default
home while the installed Host runs.

To use System from a Claude Code session in any repository, register its MCP
server once for your user ([agents](using-system.md#using-system-from-an-agent)):

```
claude mcp add --scope user system -- ~/.local/bin/system mcp
```

## Install gitleaks

The `secrets` check of `.system/checks.yaml` ([tools/secrets-check.sh](../../tools/secrets-check.sh), Item rb-5) runs
[gitleaks](https://github.com/gitleaks/gitleaks) on what a change adds to its base, with values redacted. The operator
installs the binary (8.30.1 on 2026-11-17); a machine without it fails the check with "install gitleaks", never
passes it.
The check finds it in `$GITLEAKS_BIN`, on `PATH`, or at `~/.local/bin/gitleaks` of the user who runs the Host (the check
itself has a throwaway `HOME`). It is not part of the `sh install` block above: that block is the commands a new machine
runs for System itself, and the check needs gitleaks only to verify a change.

```sh
v=8.30.1
d=$(mktemp -d) && cd "$d"
curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v$v/gitleaks_${v}_linux_x64.tar.gz"
curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v$v/gitleaks_${v}_checksums.txt"
grep " gitleaks_${v}_linux_x64.tar.gz\$" "gitleaks_${v}_checksums.txt" | sha256sum -c -
tar -xzf "gitleaks_${v}_linux_x64.tar.gz" gitleaks
install -D gitleaks ~/.local/bin/gitleaks
~/.local/bin/gitleaks version
```

## Stop, restart, status

```
systemctl --user stop system       # SIGTERM: the Host stops and exits 0
systemctl --user restart system
systemctl --user status system
```

Whatever was running when the Host stopped is lost at the next start. A Worker
attempt cut short is dispatched again by the Host once its process is confirmed
gone (it keeps its Account's slot, and its agy sign-in's shared slot, until then); a lost attempt not
confirmed gone, a verifier run or a publish or merge
effect waits for `system work run` or `retry` (verifying again, a verify step's retry, is the
Operator's at a terminal: `system work retry <work> --step <step>`). (A
Host that stopped itself for new code waits for its attempts first; see
[Upgrading](releases.md#upgrading).)

## Another home

Only `~/.dsh` gets the unit. For another `DSH_HOME`, run
`DSH_HOME=<home> system host` in a terminal (Ctrl-C stops it); keep the path
short, a socket path is limited to about 100 bytes (the longer one is
`operator/host.sock`, the operator's second socket,
[ADR-0016](../decisions/ADR-0016-the-gate-is-enforced-by-reachability.md); the
Host makes its directory at start, so an update needs nothing).
