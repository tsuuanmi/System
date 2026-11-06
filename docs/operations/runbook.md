---
type: operations
status: active
reviewed: 2026-11-07
covers: [bin/system, bin/service.mjs, packages/app/src/index.ts, packages/app/src/client.ts, packages/host/src/process.ts]
---

# Runbook

How to run the Host of the default home (`~/.dsh`) as a user service, and
what to do when it does not. The design is in [Host](../architecture/host.md#running-it).

**Status:** the Host runs as a process (H4a) and the CLI is its thin client
(H4b-1): every command but `init`, `host` and `doctor` talks to the Host on
`$DSH_HOME/system/host.sock`, so a Host must run for them.

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

The CLI prints one line and exits 1 when nothing answers at
`$DSH_HOME/system/host.sock`:

```
system: the System Host is not running for <home>: systemctl --user start system (or run: system host)
```

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

## The Host is not answering

```
system: the System Host for <home> is not answering (...): see docs/operations/runbook.md, "The Host is not answering"
```

The socket accepts connections but a call got no answer in 10 seconds. A call
that changes something (`submit`, `run`, `retry`, `cancel`, `approve`) is sent
once more with the same `commandId`, so the Host does it once: look at
`system work list` before sending it again yourself.

1. `systemctl --user status system` and `journalctl --user -u system -e`: is
   the Host alive, and busy or stuck?
2. `system doctor` boots DSH beside the Host and says whether it answers.
3. If it is stuck, `systemctl --user restart system`. Whatever was running is
   left interrupted; nothing runs again until `system work run` or `retry`.

## Following a Work, and detaching

`work submit`, `work run`, `work retry`, `approve` and `deny` return once the
Host has admitted the operation, then poll `work.events` every second until the
Work is terminal, and exit 0 (succeeded), 1 (failed), 3 (held) or 5
(cancelled). `work cancel --wait` follows the same way.

Ctrl-C **detaches**: the CLI prints `detached; <work> goes on in the Host` and
exits 0; the Work is not touched. With `--cancel-on-interrupt` Ctrl-C sends
`work.cancel` instead and follows the Work to its end; a second Ctrl-C then
detaches. Closing the terminal or killing the CLI never cancels a Work: only
`system work cancel` does. Read what happened with `system work show <id>`.

## Errors

An error is one line, `system: <message>`, never a stack. `SYSTEM_DEBUG=1`
prints the stack as well.
