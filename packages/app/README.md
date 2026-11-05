# @system/app

The `system-app` row of the [System bundle](../bundle/README.md). It reads the
launcher's inner arguments through `@deepseek-ai/dsh-cmdline`, runs one command
once the host has started (`ctx.appReady`), and exits through `ctx.appExit`.

| Command | Result |
|---|---|
| `system doctor [--json]` | which rows are mounted, and a write/read probe of the SQLite storage domain `system_doctor`; exit 0 when every required row is mounted and the probe passes, 1 otherwise |
| `system artifact put <file> [--media-type t] [--classification c]` | store the file as a `file@1` Artifact (default `local-private`, producer the operator) and print its ID |
| `system artifact show <id>` | the envelope and occurrences as JSON; exit 1 when missing |
| `system artifact cat <id>` | the bytes; exit 1 when unavailable |
| `system credentials set <NAME>` | read a value without echo (or from piped stdin) and store it in `$DSH_HOME/.credentials.yaml` through the DSH credential API; other entries are kept |
| `system credentials status <NAME...>` | `configured (<source>)` or `not configured` per name, never the value; exit 1 if any is missing |
| `system work submit (--workflow <file> \| --capability <name...>) [--input <id>] [--no-run]` | admit Work from a Workflow file or as a direct Task, print its ID, then run it |
| `system work run <workId>` | advance admitted or interrupted Work until terminal |
| `system work show <workId>` | the record (events and state) as JSON |
| `system work list` | ID, status and pinned spec of every Work |
| `system work replay <workId>` | fold the events again and compare with the stored state; runs nothing; exit 1 on mismatch |

Work exit codes: `0` succeeded, `1` failed or refused, `3` held for the
operator, `4` not terminal. Each call records its caller: `human` when stdin is
a terminal, otherwise `agent`, unless `SYSTEM_CALLER` says `human` or `agent`.
| `system --help` | help, exit 0 |

- [src/index.ts](src/index.ts) — the Cordis plugin: wiring to DSH services.
- [src/cli.ts](src/cli.ts) — the commander program.
- [src/doctor.ts](src/doctor.ts) — the checks, behind a `DoctorHost` seam so
  [tests](tests/README.md) need no host.

The operator ID is `SYSTEM_OPERATOR_ID`, or the OS user name when unset.

Built with `corepack pnpm build` into `lib/`, which the profile loads.
