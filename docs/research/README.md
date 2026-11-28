# Research

This area contains evidence, comparisons and rejected alternatives, **not**
binding requirements or current implementation claims. Findings can be
promoted through proposals and decisions, or retired with retained summaries.

The generated index below is the authoritative list of current research.

<!-- docs:begin index:research -->
- [RES-0015 — What System can take from Orca](RES-0015-orca-study.md) — active — What System can port or learn from Orca
  (stablyai/orca, MIT) at commit 196cf89 - nine Research Works and read-only subagent studies checked against System's
  dev at b0162e4; the operator's grilling of 2026-11-26 settled Antigravity Workers and Work-lifecycle Items (ag-1 to
  st-1).
- [RES-0016 — What System can take from Orca, round 2](RES-0016-orca-study-round-2.md) — active — Second round of the
  Orca study (2026-11-26), aimed at the day's own records - merge conflicts, docs-impact failures, an empty Worker
  output, unknown costs, a model comparison - with six Research Works, seven subagent studies and a scan of the stored
  Artifacts; Items redact-1 to runbook-1.
- [RES-0017 — What System can take from Paseo and Paradev](RES-0017-paseo-paradev-study.md) — active — What System can
  take from Paseo (getpaseo/paseo, Apache-2.0) and Paradev (paradevai/paradev, MIT), read on 2026-11-26 by eleven
  subagent studies and one probe of agyhome-1's design; candidates only, none settled.
- [RES-0018 — Review, verification and source control at Anthropic, against
  System](RES-0018-anthropic-review-verification-source-control.md) — active — Three Anthropic posts of 2026-10 and
  2026-11 on code review, verification and source control at agent scale, read against System's records of 2026-11-26;
  what they change in the decisions on smoke, the merge queue, gates that need a person and model review.
- [RES-0019 — Model review replay (rev-1)](RES-0019-model-review-replay.md) — active — Protocol and record of replaying
  a frontier model review (workflows/experiments/review-replay.yaml) on the diffs of two Escaped defects of 2026-11-26
  (st-1, ag-2) and ten clean merged Works, to measure recall and false alarms before any adoption; nothing is gated on
  it.
- [RES-0020 — Review eval set (evalset-1)](RES-0020-review-eval-set.md) — active — The review eval set (evalset-1) - one
  case per Escaped defect with a known change (diff, one-sentence answer key, defect ID), seeded with st-1, ag-2 and
  finish-1 of 2026-11-26; rev-1's replay reports recall on it; nothing gates on it.
- [RES-0021 — The packages against the DSH plugin standard
  (plug-2)](RES-0021-packages-against-the-dsh-plugin-standard.md) — active — The `packages/*` plugins measured on
  2026-11-27 against the DSH plugin standard of the pinned DSH 0.2.2-rc.5 (the `dsh-doc` skill and DSH's own seam
  packages) - export form, Config, services, inject, and the 40 value imports between packages, edge by edge (Item
  plug-2).
- [RES-0022 — DSH plugins, how others drive the agent CLIs, and the Scheduled
  session](RES-0022-dsh-plugins-cli-driving-and-the-scheduled-session.md) — active — What System can use from the DSH
  bundles dsh-base and dsh-web-app, how Orca, Paradev and dsh-oh-my-claude drive Claude Code, Codex and Antigravity
  (also over ACP and DSH headless), what System records about tokens and Attempt logs, what resuming a Worker's session
  would save, and how the Scheduled session did over 11 starts; settled on 2026-11-28 as ADR-0020 and Items sch-1 to
  sch-7, alog-1, alog-2, sum-1, fin-1, trace-1 and cite-1.
<!-- docs:end index:research -->
