---
id: RES-0012
type: research
status: active
summary: Reuse-first research of 2026-11-14 (five Research Works and a synthesis at baseline b789061): which findings became CM Items and which did not yet.
related: [ADR-0011, ADR-0012]
---

# Reuse-first research of 2026-11-14

Evidence, not a requirement. Baseline: `dev` at commit `b789061`. It replaces
draft PR #237's PROP-0008, RES-0012 and RES-0013, which were never merged; the
operator closes that PR. No proposal accompanies this note (operator, Q33): CM's
decisions live in [PLAN 3d](../../PLAN.md#3d-cm--continuation-and-merge-integrity-decided-2026-11-14),
[ADR-0011](../decisions/ADR-0011-human-caller-needs-a-terminal.md) and
[ADR-0012](../decisions/ADR-0012-host-carries-works-on-never-picks-items.md).

## Question
What does System still lack to carry long-term work, manage Workers, recover
from failure, bootstrap a repository and share a Worker pool, using what it,
DSH and open standards already provide, with no new engine, database,
scheduler or agent runtime?

## Research Works

Every citation of each report passed `research.citation-check`.

| Id | Topic | Work |
|---|---|---|
| R1 | Long-term decomposition (Markdown plan to Item to verified Work) | `work:dcf503df-fd54-5cb8-b079-c098beae7c6e` |
| R2 | Agent management and remote execution | `work:a79ce5e6-f9e4-5372-b330-4ff341917701` |
| R3 | Feedback loop and reliability | `work:2385b245-0968-5868-866d-120555e86f73` |
| R4 | Smallest plan/apply/check `system bootstrap` | `work:8f2a0baa-9985-529b-ac35-d67bf81a1f04` |
| R5 | Multi-Worker coordination across projects | `work:c41b7810-fc98-5fa2-ad20-9127d106395f` |
| Synthesis | Re-read the source for each kept finding | `work:d9c19b94-ed21-5eb0-84ab-506dc2c8e9aa` |

The synthesis found no case for a new engine; five defects survived a re-read
of the source (idle Works after a restart, a self-declared caller role, the
merge re-check, uncapped re-dispatch, no Item dependencies).

## Became CM Items

Those five defects, the MCP bootstrap pointer and the develop.yaml header became
Items cm-1 to cm-7 and cm-9 in [PLAN 3d](../../PLAN.md#3d-cm--continuation-and-merge-integrity-decided-2026-11-14);
the findings are not restated here.

## Not yet Items

- **`system bootstrap` plan/apply/check** over `tools/bootstrap_docs.py`
  (create-only, exclusive create, already run twice in docs CI), with a
  false-green guard: checks proposed from CI are a draft, never written live
  without a flag, and a repository with code and a docs-only checks file fails
  or warns. Evidence: R4 (command absent; MCP text says "there is no script").
- **ACP and herdr-core** as an optional Worker backend through draft PR #73;
  remote liveness is answered conservatively (a remote Worker is not known dead).
  Evidence: R2; the PR is not in the baseline, so its state is unknown.
- **Stall deadline** as a separate term from Stall (Stall stays advisory), a
  shared failure classifier, and cross-Work failure lessons (today `work.report`
  counts per Work). Evidence: R3, read from source only, nothing measured.
- **Pool baseline** from Work records before any fairness change. Evidence: R5,
  mostly assumptions; it had no checkout.
