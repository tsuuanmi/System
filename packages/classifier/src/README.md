# @system/classifier source

- [schema.ts](schema.ts) — the zod contracts (question file, answer, `classification@1`) and `generatedSchemas`.
- [generate.ts](generate.ts) — writes [`schemas/`](../schemas/README.md) from them.
- [question.ts](question.ts) — reads and hashes `classifiers/*.yaml`.
- [vote.ts](vote.ts) — the vote of the samples.
- [classifier.ts](classifier.ts) — asking, recording and looking up; failures of a Work.
- [index.ts](index.ts) — the `classifier` row.

See the [package README](../README.md).
