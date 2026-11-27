---
id: RES-0020
type: research
status: active
summary: The review eval set (evalset-1) - one case per Escaped defect with a known change (diff, one-sentence answer key, defect ID), seeded with st-1, ag-2 and finish-1 of 2026-11-26; rev-1's replay reports recall on it; nothing gates on it.
related: [RES-0018, RES-0019]
---

# Review eval set (evalset-1)

Each Escaped defect with a known change becomes a case, so a model review ([RES-0019](RES-0019-model-review-replay.md))
is measured on the misses that really happened ([RES-0018](RES-0018-anthropic-review-verification-source-control.md);
Intent `25a45ced0d2a`). **Measurement only: nothing is gated or held on it.**

## Format

One JSON file per case in [tests/fixtures/review-evalset](../../tests/fixtures/review-evalset), named `<defect>.json`:
`defect` (the Item's ID, the defect's ID until the Host's Escaped-defect Artifact ID is added), `works` (the Work IDs),
`commit` and `base` (the merged change and the commit it was made on, to replay on), `diff` (the change) and
`answerKey` (one sentence naming the defect). The files are the set: they are content in the repository, the Artifact
form of the set (an Artifact set of the operator's Host) can be made from them.
[tests/review-evalset.test.ts](../../tests/review-evalset.test.ts) checks that the set loads and each case has a
defect ID, a diff and an answer key.

## Cases

| Case | File | Answer key |
| --- | --- | --- |
| st-1 | [st-1.json](../../tests/fixtures/review-evalset/st-1.json) | the room line that broke the `workers` check |
| ag-2 | [ag-2.json](../../tests/fixtures/review-evalset/ag-2.json) | the missing inputs `--add-dir` |
| finish-1 | [finish-1.json](../../tests/fixtures/review-evalset/finish-1.json) | the Worker's end without a structured result |

The wording of each answer key was written from the Item lines and [RES-0016](RES-0016-orca-study-round-2.md), not from
the Host's defect records, which this repository does not hold: the operator corrects a key that misstates its defect.

## Use

A replay of `review-replay.yaml` on a case's `diff` (base: the case's `base`) counts the case found when a finding names
the answer key's cause at the right place (the scoring rule of RES-0019); report recall as found over cases. Add a case
when `system defect add` records an Escaped defect whose change is known.
