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
- **First question:** `failure-cause` (version 2, cls-3), asked only for a failure whose rules answer `unknown` (rb-3). `work report` shows
  such a failure under the Classification's label as `classified` (`classifiedFailures`; the range report's
  `classifiedUnknownFailures`); the rule classes and counts are unchanged. A Work that ends is classified by the Host
  in the background; `system work report <id> --classify` asks now. Its input is the Work's evidence ([evidence.ts](src/evidence.ts)):
  the reason, each check's result on the change and the base re-run, whether a later verdict passed the same content, and the
  next attempt's result; built from the record alone. Version 1 answers (made from the reason text) are still read.

## The gate (cls-2)

The gate says when a Classification may be used for more than the report. It is a measure, not a control: `gate(report)`
([eval.ts](src/eval.ts)) returns pass or fail, and no code path reads it yet.

- **The labelled set:** 41 failures of System's own Works (2026-11-14 to 17), labelled independently of the Work records and
  confirmed by the operator on 2026-11-17 (change 22, process 9, flaky 6, conflict 2, attach 1, quota 1; labels per
  failure-cause v2). Artifact `sha256:a8ad435ec0b8f7b7cbdbf879fc634dab0c5c107cfb0f26052d054a36667eee55`; copied to
  [failure-cause-labelled.json](tests/fixtures/failure-cause-labelled.json), with a snapshot of the 34 Work records it
  reads ([failure-cause-records.json](tests/fixtures/failure-cause-records.json), `system work show`), so the evaluation
  runs offline and the same every time.
- **The evaluation** (`evaluate`) places each item three ways: the **rules** (rb-3 and cls-3, `summarize` on the item's
  record: an Outside cause, `unknown`, or `change`), the **Classifier** (the question asked of the failure's evidence) and
  the **hybrid** (the rules' class unless `unknown`, then the Classifier's). The report gives for each: accuracy with its 95%
  Wilson interval, the `unknown` rate, the confusion matrix (gold by answered) and the count of **change→Outside** errors (a
  gold `change` answered with `quota`, `restart`, `conflict`, `load`, `slow-host`, `attach`, `flaky` or `process`); and for
  the Classifier the items whose samples disagreed, with a few samples. A Classifier that cannot answer counts as `unknown`.
- **The gate passes** when the hybrid is at least as accurate as the rules **and** it has no change→Outside error.
  Rules alone on the 41 items: 24/41 = 58.5% (95% 43.4–72.2%), `unknown` 12.2% (5 items); no change→Outside error.
- **Required checks never call a model:** [eval.test.ts](tests/eval.test.ts) runs the evaluation with a fake Runtime and the
  gate on a stored report ([gate-report.json](tests/fixtures/gate-report.json)).
- **The real run** is made once by the operator or a session, not by a check. `--ask-command` is a shell command that reads one
  prompt on stdin and prints the model's reply (an economy-tier model, not the Account whose failure it classifies):

  ```sh
  node tools/classifier-eval.ts --ask-command "claude -p --model haiku --tools ''" > report.json
  system artifact put report.json   # the result, kept as an Artifact
  ```

  A summary and the gate's answer go to stderr. Every miss the run shows becomes a permanent case: add it to the question's
  `examples` (a new question version) or to the set.

Tests: [vote](tests/vote.test.ts), [the core with a fake Runtime](tests/classifier.test.ts), [the schemas](tests/schemas.test.ts), [the gate](tests/eval.test.ts);
the booted profile is [tests/classifier.test.ts](../../tests/classifier.test.ts).
