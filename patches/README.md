# patches

Minimal fixes to pinned dependencies, applied by pnpm (`patchedDependencies`
in [pnpm-workspace.yaml](../pnpm-workspace.yaml)) on every install.

- `@deepseek-ai__dsh-storage-sqlite@0.2.2-rc.1.patch` — sets
  `PRAGMA busy_timeout = 5000` on DSH's SQLite connection. Without it, every
  `system` command boots a host that opens and writes the same store, and a
  second writer fails at once with "database is locked": a concurrent
  `system doctor` could kill a host running Work (tests/concurrency.test.ts;
  the M6 takeover anomaly in PLAN.md). Drop the patch when DSH sets a busy
  timeout itself; propose it upstream.
