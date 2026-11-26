---
id: RES-0019
type: research
status: active
summary: Protocol and record of replaying a frontier model review (workflows/experiments/review-replay.yaml) on the diffs of two Escaped defects of 2026-11-26 (st-1, ag-2) and ten clean merged Works, to measure recall and false alarms before any adoption; nothing is gated on it.
related: [RES-0018]
---

# Model review replay (rev-1)

**Measurement, not adoption.** [RES-0018](RES-0018-anthropic-review-verification-source-control.md) asks
whether a model review of the diff would have caught the two Escaped defects of 2026-11-26, and how often it cries wolf.
A review becomes evidence attached to a hold only if it finds both defects with few false alarms; it never blocks or
merges
(Intent `0e0a2c42aa37`; PLAN section 4 trigger "a model review step in a separate optional Workflow").

## Method

[review-replay.yaml](../../workflows/experiments/review-replay.yaml): one read-only step, `repo.read` and
`tier.frontier`, whose Task has the diff as its context and the commit the diff was made on as its base, so the Worker
reads that commit's `REVIEW.md` (if it has none, the first line of its findings says so). It writes `findings`, one line
each with a severity (blocker, major, minor, nit), a location and the input that breaks it. It has no verify, accept or
effect step.

Scoring, per diff, by the operator or a caller reading the findings against the answer key (no agent scores itself):

- **Found**: yes if a finding names the real defect's cause at the right place, whatever its severity; otherwise no.
- **False alarms**: findings of severity blocker, major or minor that are not a defect (nits are not counted).

Run each diff once, so the false-alarm count is one sample, not a rate.

## Cases

| Case | Diff | Real defect (answer key) |
| --- | --- | --- |
| st-1 | work:e09fc57c and work:2a863d03 | the room line that broke the `workers` check |
| ag-2 | work:5fce88ac | the missing inputs `--add-dir` |
| clean 1-10 | merged on dev on 2026-11-26: ms-4 `1b71c81`, gate-1 `225ec95`, env-1 `36bbf0d`, authority-1 `ecb9839`, agyhome-1 `5d0c1d1`, runbook-1 `7195bd4`, reopen-1 `55acb97`, ctx-1 `bffe05a`, redact-1 `349e24e`, out-1 `0f89072` | none known: no later Escaped defect or fix names them |

Replay each clean case on the commit's first parent with the commit's diff. Replace a case that a later fix is found to
name, and say so here.

## Results

**Not yet run.** The attempt that wrote the workflow had no Host with a frontier Account and could not read the Works'
diffs (Artifacts of the operator's Host), so it records no result and none is implied. Fill the table from the replay:

| Case | Real defect found | False alarms (blocker, major, minor) |
| --- | --- | --- |
| st-1 | | |
| ag-2 | | |
| clean 1-10 (one row each) | n/a | |

Then state the decision this evidence supports: attach the review to a hold only if both defects are found and the
false alarms stay few per clean diff; otherwise leave it as a note. Either way nothing is gated on it.
