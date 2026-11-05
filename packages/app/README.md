# @system/app

The `system-app` row of the [System bundle](../bundle/README.md). It reads the
launcher's inner arguments through `@deepseek-ai/dsh-cmdline`, runs one command
once the host has started (`ctx.appReady`), and exits through `ctx.appExit`.

| Command | Result |
|---|---|
| `system doctor [--json]` | which rows are mounted, and a write/read probe of the SQLite storage domain `system_doctor`; exit 0 when every required row is mounted and the probe passes, 1 otherwise |
| `system work` | the Work namespace; no subcommands until M2, exit 2 |
| `system --help` | help, exit 0 |

- [src/index.ts](src/index.ts) — the Cordis plugin: wiring to DSH services.
- [src/cli.ts](src/cli.ts) — the commander program.
- [src/doctor.ts](src/doctor.ts) — the checks, behind a `DoctorHost` seam so
  [tests](tests/README.md) need no host.

Built with `corepack pnpm build` into `lib/`, which the profile loads.
