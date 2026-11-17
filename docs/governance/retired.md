# Retired-document ledger

Append-only record of retired System documents, following the [documentation policy](documentation.md).

| id | title | outcome | superseded-by | retired | full-text |
|---|---|---|---|---|---|
| PROP-0001 | Proposal: first implementation slice | withdrawn | ADR-0001, PLAN.md | 2026-11-09 | `f752e79:docs/proposals/PROP-0001-system-direction.md` |
| PROP-0002 | Proposal: post-MVP-0 roadmap — Brainstorm first | withdrawn | PLAN.md | 2026-11-09 | `f752e79:docs/proposals/PROP-0002-post-mvp-roadmap.md` |
| PROP-0003 | Proposal: conversation-to-Artifact ingestion (Website Worker, layer 1) | withdrawn (the intake was dropped in df-9; the `conversation@1` kind stays) | docs/architecture/artifact-verification.md | 2026-11-09 | `f752e79:docs/proposals/PROP-0003-conversation-ingestion.md` |
| RES-0001 | Audit baseline from a reference harness | concluded | ADR-0004 | 2026-11-09 | `f752e79:docs/research/RES-0001-audit-baseline.md` |
| RES-0002 | MVP selection assessment | concluded | ADR-0004 | 2026-11-09 | `f752e79:docs/research/RES-0002-mvp-assessment.md` |
| RES-0004 | Reference audit: workflows, artifacts, verification and plugins | concluded | ADR-0002, ADR-0003 | 2026-11-09 | `f752e79:docs/research/RES-0004-reference-workflow-artifact-audit.md` |
| RES-0005 | MVP-0 plugin and component reuse audit | concluded | packages/README.md | 2026-11-09 | `f752e79:docs/research/RES-0005-plugin-reuse-audit.md` |
| RES-0006 | Brainstorm-first feasibility: three Worker executions, two existing runtimes | concluded | docs/architecture/brainstorm-composition.md | 2026-11-09 | `f752e79:docs/research/RES-0006-brainstorm-workflow-feasibility.md` |
| RES-0007 | PR #2 source review: Brainstorm, concurrency and next evaluation | concluded | docs/architecture/work-ownership-and-recovery.md | 2026-11-09 | `f752e79:docs/research/RES-0007-brainstorm-and-concurrency-review.md` |
| mvp | MVP scope and acceptance contract | concluded | docs/requirements/purpose.md | 2026-11-16 | `d66d3f5f2f55c85e73025ca50c80ff7eb37396a4:docs/requirements/mvp.md` |
| ADR-0009 | Goals and Orchestrators | superseded (the Goal feature was removed in DF2, 2026-11-09) | ADR-0012 | 2026-11-16 | `97a1adb2756e31eed15434fb9916b83dd2fa7255:docs/decisions/ADR-0009-goals-and-orchestrators.md` |
| PROP-0004 | Proposal: the Host (milestone H) | accepted, built (R1, R2) | docs/architecture/host.md, ADR-0007 | 2026-11-16 | `97a1adb2756e31eed15434fb9916b83dd2fa7255:docs/proposals/PROP-0004-host-design.md` |
| PROP-0005 | Proposal: the ChatGPT Website Worker | accepted, built (milestones W, WW) | packages/web-worker/README.md | 2026-11-16 | `97a1adb2756e31eed15434fb9916b83dd2fa7255:docs/proposals/PROP-0005-chatgpt-website-worker.md` |
| PROP-0006 | Proposal: a replaceable Orchestrator, and the checks as a Sub-workflow | accepted, built (milestone OC; the Goal parts were removed in DF2) | docs/architecture/workflow-composition.md, ADR-0002 | 2026-11-16 | `97a1adb2756e31eed15434fb9916b83dd2fa7255:docs/proposals/PROP-0006-replaceable-orchestrator-and-code-checks.md` |
| PROP-0007 | Proposal: Worker policy, faster and clearer checks, and a merge queue | accepted, built | ADR-0008, packages/verifiers/README.md, packages/effects/README.md | 2026-11-16 | `97a1adb2756e31eed15434fb9916b83dd2fa7255:docs/proposals/PROP-0007-worker-policy-checks-and-merge-queue.md` |
| RES-0008 | Brainstorm evaluation (B3): five briefs, three arms | concluded (the experiments it compared were deleted in 8018e2d) | docs/architecture/brainstorm-composition.md | 2026-11-16 | `97a1adb2756e31eed15434fb9916b83dd2fa7255:docs/research/RES-0008-brainstorm-evaluation.md` |
