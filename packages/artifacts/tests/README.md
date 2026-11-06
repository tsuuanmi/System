# @system/artifacts tests

Unit tests with in-memory fakes of the DSH table and attachment store. The
fake table, like DSH, applies a write in memory only after it is durable, so a
missing per-ID write lock is caught. The booted store over real DSH storage
is covered by the [smoke test](../../../tests/README.md).
