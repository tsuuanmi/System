# patches

Minimal fixes to pinned dependencies, applied by pnpm (`patchedDependencies`
in [pnpm-workspace.yaml](../pnpm-workspace.yaml)) on every install.

- `@deepseek-ai__dsh-storage-sqlite@0.2.2-rc.1.patch` — sets
  `PRAGMA busy_timeout = 5000` on DSH's SQLite connection. Without it, every
  `system` command boots a host that opens and writes the same store, and a
  second writer fails at once with "database is locked": a concurrent
  `system doctor` could kill a host running Work (tests/concurrency.test.ts;
  the M6 takeover anomaly in the [MVP-0 plan](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md)).
  The same patch fixes two races when several processes find the store
  missing and create it together: the switch to WAL is retried (SQLite
  answers it "database is locked" without consulting the busy timeout), and a
  unit's version row is inserted with `INSERT OR IGNORE` and read back instead
  of failing with `UNIQUE constraint failed: units.name`. Drop the patch when
  DSH fixes these itself (upstream discussion deepseek-ai/deepseek-harness#718).
- `@deepseek-ai__dsh@0.2.2-rc.1.patch` — every DSH boot rewrote
  `profiles/<name>/cordis.yml` (truncate, then write), so a host booting
  alongside could read it empty and fail ("config file must be a top-level
  array"; seen once in `tests/concurrency.test.ts`). It is now written only
  when it differs, and then atomically. The test that a boot leaves the file
  untouched was red before. Drop the patch when DSH does the same.
