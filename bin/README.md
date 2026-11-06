# bin

[`system`](system) is the CLI wrapper
([ADR-0004](../docs/decisions/ADR-0004-mvp-0-operating-decisions.md) decision 2):

- `system init` writes `$DSH_HOME/profiles/system/package.json` with the
  [System bundle](../packages/bundle/README.md) as its only bundle (linked from
  this checkout), creates an empty operator patch once, and runs
  `dsh plugin --profile system install`.
- Every other command runs `dsh --profile system <args>`.

`DSH_HOME` defaults to `~/.dsh`. The wrapper uses the workspace's pinned DSH
launcher and puts the workspace's pinned `pnpm` on `PATH`, because
`dsh plugin` runs pnpm. It needs Node `>=24.9.0`.
