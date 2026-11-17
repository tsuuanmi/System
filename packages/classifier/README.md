# @system/classifier

The `classifier` row (cls-1): an **optional, off** row, like `web-worker`. It answers one closed question about an
Artifact and records the answer. It is not a Verifier: a Classification is never a ground for acceptance, and no
code path routes, retries, holds or verifies on one. Only `system work report` reads it.

- **Injects:** `artifacts`, `storageDomain`, `agents`. **Provides:** `ctx.classifier` (`failures`: what `work report` reads).
  Listed after `agents` in the bundle; a profile patch turns it on with `disabled: false`.
- **A question** is a versioned YAML file under [`classifiers/`](../../classifiers/failure-cause.yaml): instructions, labels
  with descriptions (always including `unknown`), a few examples, `samples`.
- **Asking:** the question goes `samples` times, one turn each with no tools, to an economy-tier Account of the `agents`
  row (`AgentsService.ask`), never the Account whose failure it classifies. A turn that fails records nothing, so a later
  report asks again; the Classifier never fails a step.
- **Voting** ([vote.ts](src/vote.ts)): the distribution is each label's share of the votes, the confidence the winner's
  share. A tie, a winner under 2/3, or an answer outside the question's labels is `unknown`; disagreement is recorded.
- **Recording:** one `classification@1` Artifact per answer (the input's hash, the question's file hash, name and version,
  each sample's Account, model and Runtime version, distribution, confidence, label). It is looked up by question and
  input hash and read, never asked again.
- **Contracts** are JSON Schema in [`schemas/`](schemas), generated from the zod schemas of [schema.ts](src/schema.ts)
  (`node packages/classifier/src/generate.ts`); a test fails when they drift, and validates the shipped questions.
- **First question:** `failure-cause`, asked only for a failure whose rules answer `unknown` (rb-3). `work report` shows
  such a failure under the Classification's label as `classified` (`classifiedFailures`; the range report's
  `classifiedUnknownFailures`); the rule classes and counts are unchanged. A Work that ends is classified by the Host
  in the background; `system work report <id> --classify` asks now.

Tests: [vote](tests/vote.test.ts), [the core with a fake Runtime](tests/classifier.test.ts), [the schemas](tests/schemas.test.ts);
the booted profile is [tests/classifier.test.ts](../../tests/classifier.test.ts).
