# bin

[`system`](system) is the CLI wrapper
([ADR-0004](../docs/decisions/ADR-0004-mvp-0-operating-decisions.md) decision 2):

- `system init` writes `$DSH_HOME/profiles/system/package.json` with the
  [System bundle](../packages/bundle/README.md) as its only bundle (linked from
  this checkout, or for a release of the install from its `current` link), creates an empty operator patch once, and runs
  `dsh plugin --profile system install`.
  On Linux, for the default home only, it also writes the Host's user unit
  `~/.config/systemd/user/system.service`, runs `systemctl --user daemon-reload`
  and `loginctl enable-linger`, and prints the command that enables it (it never
  enables or starts it). `--no-service` or `SYSTEM_NO_SERVICE=1` skips that; any
  other home is told to run `system host` in the foreground.
- `system update [--wait <minutes>]` moves the install (`~/.system`, or
  `SYSTEM_INSTALL`) to the newest commit of `main`, only after that commit
  passed its own required checks as a System Work on this machine
  ([update.mjs](update.mjs); the
  [runbook](../docs/operations/runbook.md#install-and-start)).
- `system host --supervise` (development, no systemd) stays as a small
  supervisor around `system host` and runs it again (through the install's
  `bin/system`, so a switched `current` is new code) after exit 75, the status of
  a Host that stopped to run new code; any other exit ends it with that status.
  `host` is found after DSH's own options too (`system --patch f host --supervise`).
- `system host` and `system doctor` (and any command led by a DSH flag, such as
  `--patch f host`) run `dsh --profile system <args>`; SIGTERM sent to the
  wrapper reaches DSH, and its exit status is the wrapper's.
- Every other command runs in the thin client of the Host
  ([client.ts](../packages/app/src/client.ts)): it does not boot DSH and needs
  no profile, only a Host on `$DSH_HOME/system/host.sock`.
- [service.mjs](service.mjs) (typed by [service.d.mts](service.d.mts)) holds the
  decisions that need no DSH: the unit text (`Restart=on-failure` and
  `RestartForceExitStatus=75`), whether init installs it, the supervisor loop,
  the Node choice, and whether this code is a release of the install
  (`installRoot`). A release runs as the install's `current` link: the Host
  watches the code there (`SYSTEM_CODE`) and upgrades when the link moves.

`DSH_HOME` defaults to `~/.dsh`. The wrapper uses the workspace's pinned DSH
launcher and puts the workspace's pinned `pnpm` on `PATH`, because
`dsh plugin` runs pnpm. It needs Node `>=24.9.0`: under an older one it runs the
same command with the newest Node 24 of that version under
`~/.nvm/versions/node/`, or fails naming `nvm install 24`.
