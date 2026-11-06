# bin

[`system`](system) is the CLI wrapper
([ADR-0004](../docs/decisions/ADR-0004-mvp-0-operating-decisions.md) decision 2):

- `system init` writes `$DSH_HOME/profiles/system/package.json` with the
  [System bundle](../packages/bundle/README.md) as its only bundle (linked from
  this checkout), creates an empty operator patch once, and runs
  `dsh plugin --profile system install`.
  On Linux, for the default home only, it also writes the Host's user unit
  `~/.config/systemd/user/system.service`, runs `systemctl --user daemon-reload`
  and `loginctl enable-linger`, and prints the command that enables it (it never
  enables or starts it). `--no-service` or `SYSTEM_NO_SERVICE=1` skips that; any
  other home is told to run `system host` in the foreground.
- `system host` and `system doctor` (and any command led by a DSH flag, such as
  `--patch f host`) run `dsh --profile system <args>`; SIGTERM sent to the
  wrapper reaches DSH, and its exit status is the wrapper's.
- Every other command runs in the thin client of the Host
  ([client.ts](../packages/app/src/client.ts)): it does not boot DSH and needs
  no profile, only a Host on `$DSH_HOME/system/host.sock`.
- [service.mjs](service.mjs) (typed by [service.d.mts](service.d.mts)) holds the
  decisions that need no DSH: the unit text, whether init installs it, and the
  Node choice.

`DSH_HOME` defaults to `~/.dsh`. The wrapper uses the workspace's pinned DSH
launcher and puts the workspace's pinned `pnpm` on `PATH`, because
`dsh plugin` runs pnpm. It needs Node `>=24.9.0`: under an older one it runs the
same command with the newest Node 24 of that version under
`~/.nvm/versions/node/`, or fails naming `nvm install 24`.
