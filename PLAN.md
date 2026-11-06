# PLAN.md — System next implementation: Brainstorm first

> **Status:** draft execution handoff for the next iteration, updated 2026-11-06.
> **Implementation target:** [PR #2](https://github.com/tsuuanmi/System/pull/2)
> (`mvp0/implementation`, observed at `7099428`), **not PR #1**.
> **No code for the next iteration has been implemented by this docs update.**
> This checklist is not a new ADR or an alternate source of product requirements.

## 0. Read and align

- [Product Charter](docs/requirements/purpose.md), [accepted ADRs](docs/decisions/README.md)
  and [MVP scope](docs/requirements/mvp.md) define product/architecture truth.
- [PROP-0002 roadmap](docs/proposals/PROP-0002-post-mvp-roadmap.md) is the
  **canonical draft priority proposal**. [RES-0006](docs/research/RES-0006-brainstorm-workflow-feasibility.md)
  explains implementation feasibility and what to learn from System 1.
- The earlier M0–M6 implementation checklist is in the Git history and
  [PR #2's PLAN.md](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md).
  Do not reset MVP-0 progress or repeat its completed work. At the observed
  PR #2 commit, tests and authorized throwaway GitHub publish were reported
  complete; recheck the actual current local state before modifying code.
- **Research now:** keep the existing end-to-end Research flow operational.
  Claim-level checking and more rigorous citation verification are **future
  capabilities**, not blockers for this Brainstorm iteration.
- **Website Worker:** research that needs interactive/login-gated websites
  comes **after** the Brainstorm milestone, not before.
- **Security isolation:** not the goal of this iteration; do not expand scope
  into container/egress infrastructure merely to ship Brainstorm.

## 1. What we are shipping

**Outcome:** a user submits one Brainstorm brief and receives **three
immutable Worker output Artifacts**: two independent alternative proposals
from **Claude Code + Codex** and one synthesis from either existing Worker.
The same `WorkController` executes the externally configured Workflow.
No additional provider type, new Work authority, domain engine or required
VerifierPort. Three *executions/roles* are sufficient; not three provider
implementations. Completion means output delivery, **not** factual approval.

```text
brief Artifact ID
    ├── idea-a (Claude) → proposal-a Artifact ID ─┐
    └── idea-b (Codex)  → proposal-b Artifact ID ─┤
                                                      ↓
                                       synthesis (Claude or Codex)
                                                      ↓
                                            summary Artifact ID
```

The two idea steps have only the initial brief as input. The synthesis
step receives the two exact proposal IDs and brief. **Scheduling is
sequential** in current code even if dependencies are independent;
parallelism is explicitly not a release requirement.

## 2. Execution checklist and gates

### B0 — Confirm the MVP-0 baseline (short)

- [ ] Check the current PR #2 head, clean local working tree and pinned DSH
  version. Do not overwrite local uncommitted work or rebase without consent.
- [ ] Run existing offline build/unit/smoke tests and `system doctor`;
  record command, exit status, source SHA and enabled Worker accounts.
- [ ] Inspect `packages/work/src/workflow.ts`, `controller.ts`,
  `registry.ts`, `packages/agents/src/index.ts`, `workspace.ts`
  before changing anything. Existing `system.workflow/v1` can express B1.
- [ ] Keep existing Software Engineering and Research workflows passing.
  No verifier rewrite or independent DSH plugin framework.

**Gate:** baseline documented, both existing workflow fixtures preserved.

### B1 — Brainstorm YAML, reuse Claude and Codex (next feature)

- [ ] Add `workflows/brainstorm.yaml` using current strict
  `system.workflow/v1`: `idea-a`, `idea-b`, `synthesis` Worker steps.
  Each produces a named file Artifact; no `verify` or `accept` required.
- [ ] Add account capability labels via DSH composition/profile config:
  `brainstorm.idea-a` for Claude, `brainstorm.idea-b` for Codex, and
  `brainstorm.synthesis` for one existing account. Retain provider-neutral
  `WorkerPort`; no new Worker or domain-specific Controller branch.
- [ ] Ensure `idea-b` has no input reference to `idea-a`; synthesis
  declares `dependsOn: [idea-a, idea-b]` and inputs both proposal slots.
- [ ] Write concise role instructions asking for distinct alternatives,
  assumptions, trade-offs, failure modes and unresolved questions. Synthesis
  compares arguments and proposes next experiments; no false consensus.
- [ ] Add fake Worker tests: exactly three attempts, expected provider refs,
  two independent inputs, Artifact ID handoff, distinct provenance, pinned
  spec, failed capability preflight and no required verifier.
- [ ] Make result Artifact IDs and step statuses inspectable using existing
  CLI. Do not build a new UI or transcript-chat layer.

**Gate:** fake Brainstorm run completes with three stored Artifact outputs,
correct independent/synthesis inputs and no Work Core modifications.

### B2 — Real run and recovery

- [ ] Run a real credential-gated brief: Claude proposal, Codex proposal,
  third synthesis. Record provider/model/tier actually served, attempts,
  input/output Artifact IDs and elapsed time.
- [ ] Inject stop/crash after first idea; restart and confirm the completed
  Artifact is reused, not generated again. `work replay` matches.
- [ ] Test cancellation, unavailable Codex account and changed Workflow file:
  route refusal explicit; old Work retains admitted spec and output IDs.
- [ ] Re-run existing code and research smoke tests after adding account
  capability labels.

**Gate:** real three-attempt run and recovery pass; no accidental
same-provider substitution for the two independent perspectives.

### B3 — Brainstorm daily-driver evaluation

- [ ] Try at least five varied briefs (architecture, tradeoffs, feature
  design, failure analysis and open-ended ideation).
- [ ] Compare a single-Worker baseline to the three-role workflow. Record
  operator usefulness, novelty, diversity, actual disagreements, latency,
  usage observations (or `unknown`) and manual interventions.
- [ ] Capture operator feedback as evidence Artifacts where useful. A model
  self-scoring quality is not sufficient evidence of better decisions.
- [ ] Only optimize role/tier selection or add optional critique on observed
  limitations. No team ballots or debate rounds without demonstrated need.

**Gate:** a report of real tasks and measured trade-offs, not just a demo.

### B4 — Focused reliability (may run alongside B1–B3)

- [ ] Keep and extend multi-CLI same-Work concurrency regression tests
  for the DSH SQLite `busy_timeout` patch. Test lost updates, duplicate
  dispatch and replay after forced termination.
- [ ] Avoid new process daemon/lease framework unless a minimal reproducer
  demonstrates a correctness defect. Record fixes independently.

**Gate:** no known Work state correctness regression from the Brainstorm
feature and retained tests for the SQLite patch.

## 3. System 1 reference: adopt only the small mechanisms

See the [pinned source audit](docs/research/RES-0006-brainstorm-workflow-feasibility.md#system-1-as-a-reference-what-to-copy-conceptually)
at `tsuuanmi/system_1@f199a277`:

- **Adopt:** independent proposals, distinct provider/account perspectives,
  immutable member results, explicit synthesis, candidate objections and
  decision provenance.
- **Adapt:** use role capability labels and current Artifact-ID bindings in
  external YAML; track which provider *actually* handled each role.
- **Defer:** sealed ballots, majority vote, debate rounds, persistent team
  conversations, a monolithic team engine, cross-member peer messaging.
- **Future Research reference:** two independent literature reviews,
  structured evidence table, independent critique and conclusion are useful
  once Website Worker/research evaluation is in scope. Do not port its coded
  research template directly.

## 4. After Brainstorm — future, not current gates

- [ ] Website Worker for interactive/browser-assisted Research **only when**
  a real source workflow requires it; keep the same WorkerPort/Artifact IDs.
- [ ] Research quality capabilities (source snapshots, citation consistency,
  claim-to-evidence checking) as separately selected verifiers. The **current
  Research flow continues to work**, without mandatory stronger verification.
- [ ] Optional Skill, LSP, web-fetch or third Worker adapter only if a
  measured use case requires it and the pinned DSH plugin can satisfy
  the System contract without duplicating the model loop.
- [ ] Parallel independent steps, additional provider accounts and adaptive
  routing only if B3 results justify their overhead.

## 5. Progress and handoff

| Stage | Status | Commit / PR | Test/evidence |
|---|---|---|---|
| B0 MVP-0 baseline | not started | — | — |
| B1 Brainstorm YAML | not started | — | — |
| B2 Real three Worker attempts | not started | — | — |
| B3 Daily driver evaluation | not started | — | — |
| B4 Concurrency regression | not started | — | — |

Update this table *after executing tests*. Each implementation milestone
should be a small reviewable commit on the chosen implementation branch.
If YAML role routing cannot ensure Claude + Codex, provide a failing
reproducer before proposing a schema change. **Do not silently add another
runtime, change a decided ADR, or mutate the documentation-only PR into a
code PR.**

**Done =** one System Work containing two independently authored proposal
Artifacts and one synthesized Artifact, replayable after restart, with
provider provenance and no need for an additional Worker type. The
research/verifier/browser expansions remain future work.
