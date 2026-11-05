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
| `system approve <workId> [--reason r]` | approve what held Work awaits (an effect needing approval, an inconclusive verdict, `approval: operator`) and run it on; a human at a terminal must type the Work ID's first 8 characters |
| `system deny <workId> --reason r` | deny it; the Work fails. Same terminal confirmation |
| `system task new (--text t \| --file f) [--repo path [--ref r]]` | store a `task@1` input; with `--repo`, first the exact base commit as `git-tree@1` |
| `system workers` | registered Workers, and each agent account with its CLI version or why it is unavailable |
| `system credentials set <NAME>` | read a value without echo (or from piped stdin) and store it in `$DSH_HOME/.credentials.yaml` through the DSH credential API; other entries are kept |
| `system credentials status <NAME...>` | `configured (<source>)` or `not configured` per name, never the value; exit 1 if any is missing |
| `system work submit (--workflow <file> \| --capability <name...>) [--input <id>] [--no-run]` | admit Work from a Workflow file or as a direct Task, print its ID, then run it |
| `system work cancel <workId> [--reason r] [--wait]` | stop running Work: a live host is asked to stop its attempt (SIGTERM, SIGKILL after 30 s) and records the outcome; otherwise it is recorded here. Partial output is kept, unaccepted |
| `system work retry <workId> [--step id] [--worker ref] [--reason r]` | run a Worker step of failed, cancelled or held Work again as a new attempt (default: the first that did not succeed), optionally by one named Worker, starting from the last attempt's partial output; every later step is reset |
| `system work run <workId>` | advance admitted or interrupted Work until terminal |
| `system work show <workId>` | the record (events and state) as JSON |
| `system work list` | ID, status and pinned spec of every Work |
| `system work replay <workId>` | fold the events again and compare with the stored state; runs nothing; exit 1 on mismatch |

Work exit codes: `0` succeeded, `1` failed or refused, `3` held for the
operator, `4` not terminal, `5` cancelled. Each call records its caller: `human` when stdin is
a terminal, otherwise `agent`, unless `SYSTEM_CALLER` says `human` or `agent`.
| `system --help` | help, exit 0 |

- [src/index.ts](src/index.ts) — the Cordis plugin: wiring to DSH services.
- [src/cli.ts](src/cli.ts) — the commander program.
- [src/doctor.ts](src/doctor.ts) — the checks, behind a `DoctorHost` seam so
  [tests](tests/README.md) need no host.

The operator ID is `SYSTEM_OPERATOR_ID`, or the OS user name when unset.

Built with `corepack pnpm build` into `lib/`, which the profile loads.
