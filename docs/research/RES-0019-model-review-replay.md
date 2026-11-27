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

Replayed once per case on each runtime: codex/x2 (gpt-6-astra, frontier) and claude-code/c2 (Opus,
frontier). The findings are in the Artifact
sha256:46ee685d8c6a9ad7efb1f2d6c7006baff6024e21cd6f7c603ad89ebbb07bd0cd,
per case and runtime, with their Work IDs. The caller session scored them against the answer key and against
origin/dev; no agent scored itself. Counts
are blocker/major/minor findings (nits not counted); no run reported a blocker. "Confirmed real" lists findings the
caller checked; every other finding is unverified, so the counts are not a false-alarm rate.

| Case | codex: found? | codex: b/ma/mi | claude: found? | claude: b/ma/mi | Confirmed real |
| --- | --- | --- | --- | --- | --- |
| st-1 | no | 0/2/0 | no | 0/1/1 | both: `readyCount` (packages/work/src/status.ts ~166) omits claims, so a claimed Item counts as Ready while `item.list` shows it claimed. Unverified: `workers.list` ignores `status.problems` and reports 0 when STATUS.md is missing. The real defect (the `room:` line at column 0 that broke the afterInstall `workers` check) was not found. |
| ag-2 | no | 0/0/0 | no | 0/1/1 | claude: Antigravity attempts use the Account's persistent HOME (real; agyhome-1 later fixed it). Unverified: a QUOTA regex matching any "quota" text. The real defect (missing `--add-dir` for the inputs) was not found. |
| ms-4 | n/a | 0/0/0 | n/a | 0/0/0 | none (unverified) |
| gate-1 | n/a | 0/0/0 | n/a | 0/0/0 | none (unverified) |
| env-1 | n/a | 0/0/1 | n/a | 0/0/2 | codex: the test deletes CLAUDE_CODE_OAUTH_TOKEN without restoring it (real, test hygiene). Claude: adapters listed by hand and `ask.ts` env not covered (unverified). |
| authority-1 | n/a | 0/0/0 | n/a | 0/0/1 | none (unverified) |
| agyhome-1 | n/a | 0/0/0 | n/a | 0/0/0 | none (unverified) |
| runbook-1 | n/a | 0/0/0 | n/a | 0/0/1 | none (unverified) |
| reopen-1 | n/a | 0/1/1 | n/a | 0/1/2 | both, unverified: a change's own fail verdict carrying "the base fails it too" is read by `outsideCause` as an Outside load failure (packages/verifiers/src/checks.ts ~376), and `writeFailingChecks` skips a check failed only for leftover processes (packages/agents/src/workspace.ts ~111). |
| ctx-1 | n/a | 0/1/0 | n/a | 0/1/0 | both, unverified: the web Worker's prompt (packages/web-worker/src/chatgpt.ts ~384, `inline(ws.context)`) still lists context without Artifact IDs. |
| redact-1 | n/a | 0/3/0 | n/a | 0/1/1 | both: `redactLog` splits lines before the multi-line `pem` pattern, leaving the key body. Recorded as Escaped defect sha256:03e6fe2fce0970bfba0960d3a1e791ff474e4c77810d6dd1e9ce2e1ed62c562e. |
| out-1 | n/a | 0/0/0 | n/a | 0/0/1 | none (unverified) |

Follow-up Items from these findings: redact-2, ready-2, reopen-2, ctx-2, envtest-1 in STATUS.md.

## Conclusion

On the two Escaped defects, recall is 0 of 2 for both runtimes, so under the protocol's rule the review is not attached
to a hold. On ten "clean" merged diffs, the two runtimes independently agreed on five defects (`readyCount`, the `pem`
split, the two reopen-1 findings, the ctx-1 prompt); the caller confirmed two of them (pem, `readyCount`), and one more
finding, found by Claude alone (the persistent HOME), was real. Agreement of two different models is a useful filter
(cf. RES-0018: Anthropic posts only findings verifiers vote for). Next measurement: evalset-1's cases, a run on each new
Escaped defect, and counting how many agreed findings turn out real. Nothing is gated on it.
