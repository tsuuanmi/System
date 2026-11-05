# @system/bundle

The only bundle of the `system` DSH profile. [cordis.patch.yml](cordis.patch.yml)
inserts the complete Cordis tree; it does **not** layer over `dsh-base`, so no
agent loop, model adapter, sandbox, web server or telemetry row is mounted
([ADR-0001](../../docs/decisions/ADR-0001-control-plane-on-dsh.md) point 3,
[ADR-0004](../../docs/decisions/ADR-0004-mvp-0-operating-decisions.md)).

## Rows

| Row | Package | Service | Required | Why |
|---|---|---|---|---|
| `storage` | `@deepseek-ai/dsh-storage` | `storage` | yes | storage hub |
| `storage-sqlite` | `@deepseek-ai/dsh-storage-sqlite` | `storage.backend.sqlite` | yes | SQLite file `$DSH_HOME/system/state.sqlite`, WAL journal |
| `storage-domain` | `@deepseek-ai/dsh-storage-domain` | `storageDomain` | yes | Work and Artifact records (ADR-0004 decision 9), default backend `sqlite` |
| `attachment-local` | `@deepseek-ai/dsh-attachment-local` | `attachments` | yes | content-addressed Artifact bytes under `$DSH_HOME/attachments/v1` |
| `subprocess` | `@deepseek-ai/dsh-subprocess-local` | `subprocess` | yes | Worker and verifier processes (from M3) |
| `credentials` | `@deepseek-ai/dsh-credentials-local` | `credentials` | no | key references; unused in M0, may be disabled |
| `system-app` | `@system/app` | — | yes | the CLI |

Each row is mounted because a System contract needs it; adding a row adds a
line here, to `ROWS` in [`packages/app/src/doctor.ts`](../app/src/doctor.ts)
when it provides a service, and to `EXPECTED_ROWS` in the
[smoke test](../../tests/smoke.test.ts).

## Disabling a row

Rows are disabled in the profile's own patch, `$DSH_HOME/profiles/system/cordis.patch.yml`,
never by deleting the package:

```yaml
- id: credentials
  disabled: true
```

`system doctor` then reports the row as `disabled`. Disabling a required row
makes `system doctor` fail with the row named (exit 1). Toggling a row while
Work is in flight is MVP-1.

## Pins

All DSH packages are `0.2.2-rc.1`, tag commit `66491b05`; `engines.dsh` pins
the runtime. Install scripts of DSH dependencies are denied in
[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml).

## Measured on 2026-11-05 (Linux 5.4, Node 24.21.0)

- `system doctor`: about 1.05 s wall time, about 89 MB peak RSS, 7 rows mounted.
- Installed closure: 604 packages, 642 MB of `node_modules`. The
  `@deepseek-ai/dsh` launcher package depends on the default DSH stack
  (`dsh-base`, web, headless, tools); those packages are installed but **not
  mounted**.

## Known limitations

- `attachment-local` and `subprocess` are only checked for presence; they are
  first used by Artifacts (M1) and Workers (M3).
- DSH's SQLite backend sets `journal_mode` but not `synchronous`; the M2 crash
  tests must measure the effective level.
- pnpm reports unmet `@opentelemetry/api` peer ranges inside DSH's own
  dependencies; System code does not use OpenTelemetry.
- The profile links this checkout (`link:`), so it is a development install,
  not a release.
