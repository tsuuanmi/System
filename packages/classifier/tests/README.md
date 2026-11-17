# @system/classifier tests

- [vote.test.ts](vote.test.ts) — the vote rules.
- [classifier.test.ts](classifier.test.ts) — the core with a fake Runtime: recorded once, read never re-asked, a failing Runtime records nothing.
- [schemas.test.ts](schemas.test.ts) — the generated JSON Schema files do not drift, and validate the shipped questions and a recorded Classification.
- [eval.test.ts](eval.test.ts) — the gate's evaluation on the fixtures in [fixtures/](fixtures) with a fake Runtime (matrix, rules-only accuracy, disagreement), and the gate on a stored report.

The booted profile with the row on is [tests/classifier.test.ts](../../../tests/README.md).
