---
type: operations
status: active
reviewed: 2026-11-06
covers: [bin/system, bin/service.mjs, packages/app/src/index.ts, packages/host/src/process.ts]
---

# Runbook

How to run the Host of the default home (`~/.dsh`) as a user service, and
what to do when it does not. The design is in [Host](../architecture/host.md#running-it).

**Status:** the Host runs as a process (H4a). Until the CLI goes through its
socket (H4b), commands that change Work do not work while it runs; read the
[guard message](#a-host-is-running-for-home).

## Install and start

`system init` writes `~/.config/systemd/user/system.service`, runs
`systemctl --user daemon-reload` and `loginctl enable-linger $USER`, and prints
the two commands that turn it on. It never enables or starts the service:

```
systemctl --user enable --now system
```

`system init --no-service` (or `SYSTEM_NO_SERVICE=1`) skips all of this. Run
`system init` again after moving the checkout, changing Node or changing
`PATH`: the unit holds the Node binary and the `PATH` of the last init.

## Stop, restart, status

```
systemctl --user stop system       # SIGTERM: the Host stops and exits 0
systemctl --user restart system
systemctl --user status system
```

Whatever was running when the Host stopped is lost at the next start and is
left interrupted; nothing runs again until `system work run` or `retry`.

## Another home

Only `~/.dsh` gets the unit. For any other `DSH_HOME`, run
`DSH_HOME=<home> system host` in a terminal; Ctrl-C stops it. A socket path is
limited to about 100 bytes, so keep that home's path short.

## Logs

```
journalctl --user -u system            # everything
journalctl --user -u system -f         # follow
```

The Host writes one line to stderr at start (`system host: started for <home>,
listening on <socket>`) and one at stop (`system host: stopped`).

## Host not running

The client says so when nothing answers at `$DSH_HOME/system/host.sock`:

1. `systemctl --user status system`: is it `active`? If not, start it.
2. If it failed, read `journalctl --user -u system -e`. A missing `claude`,
   `codex` or `git` is a `PATH` captured at init that no longer holds: run
   `system init` again from a shell that has them.
3. `Node >=24.9.0` errors: `bin/system` runs the newest Node 24 under
   `~/.nvm/versions/node/` by itself; with none, install one (`nvm install 24`).
4. `another Host already runs for <home>`: one is running, perhaps one in a
   terminal. Stop it; there is one Host per home.

A stale `host.sock` file is not a problem: the Host removes it once it holds
the home.

## A Host is running for <home>

```
system: a Host is running for <home>; stop it first (systemctl --user stop system)
```

Until H4b, the commands that change Work (`work submit`, `run`, `retry`,
`cancel`, `approve`, `deny`) run their own controller, and two writers on one
home are refused. Stop the service, run the command, start it again.
Reading (`work show`, `list`, `report`, `replay`) is not refused.
