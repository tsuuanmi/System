# PLAN.md — System next implementation: Brainstorm first

> **Status:** draft execution handoff for the next iteration, updated 2026-11-06.
> **Implementation target:** [PR #2](https://github.com/tsuuanmi/System/pull/2)
> (`mvp0/implementation`, observed at `7099428`), **not PR #1**.
> **B0–B4 are done on PR #2 (B3 scored by a model judge, see RES-0008).**
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

- [x] Check the current PR #2 head, clean local working tree and pinned DSH
  version. Do not overwrite local uncommitted work or rebase without consent.
  *(PR #1 merged into `mvp0/implementation` at `41d2e0a`, no rebase; tree clean; DSH `0.2.2-rc.1`.)*
- [x] Run existing offline build/unit/smoke tests and `system doctor`;
  record command, exit status, source SHA and enabled Worker accounts.
  *(`corepack pnpm check` at `41d2e0a`, Node 24.21.0: exit 1, unit 114/114, smoke 33/36 with 2 skipped and 1 failure: `tests/concurrency.test.ts`, "entries did not activate"; fixed under B4. `system doctor` exit 0; `system workers`: `claude-code/default` (2.1.311) and `codex/default` (0.166.0) available.)*
- [x] Inspect `packages/work/src/workflow.ts`, `controller.ts`,
  `registry.ts`, `packages/agents/src/index.ts`, `workspace.ts`
  before changing anything. Existing `system.workflow/v1` can express B1.
  *(Confirmed: file inputs reach a step as read-only files, a Workflow without `accept` ends "every step succeeded", ready steps run in file order, and submit already refuses a capability no enabled Worker provides.)*
- [x] Keep existing Software Engineering and Research workflows passing.
  No verifier rewrite or independent DSH plugin framework.

**Gate:** baseline documented, both existing workflow fixtures preserved.

### B1 — Brainstorm YAML, reuse Claude and Codex (next feature)

- [x] Add `workflows/brainstorm.yaml` using current strict
  `system.workflow/v1`: `idea-a`, `idea-b`, `synthesis` Worker steps.
  Each produces a named file Artifact; no `verify` or `accept` required.
- [x] Add account capability labels via DSH composition/profile config:
  `brainstorm.idea-a` for Claude, `brainstorm.idea-b` for Codex, and
  `brainstorm.synthesis` for one existing account. Retain provider-neutral
  `WorkerPort`; no new Worker or domain-specific Controller branch.
- [x] Ensure `idea-b` has no input reference to `idea-a`; synthesis
  declares `dependsOn: [idea-a, idea-b]` and inputs both proposal slots.
- [x] Write concise role instructions asking for distinct alternatives,
  assumptions, trade-offs, failure modes and unresolved questions. Synthesis
  compares arguments and proposes next experiments; no false consensus.
- [x] Add fake Worker tests: exactly three attempts, expected provider refs,
  two independent inputs, Artifact ID handoff, distinct provenance, pinned
  spec, failed capability preflight and no required verifier.
- [x] Make result Artifact IDs and step statuses inspectable using existing
  CLI. Do not build a new UI or transcript-chat layer.

**Gate:** fake Brainstorm run completes with three stored Artifact outputs,
correct independent/synthesis inputs and no Work Core modifications.

### B2 — Real run and recovery

- [x] Run a real credential-gated brief: Claude proposal, Codex proposal,
  third synthesis. Record provider/model/tier actually served, attempts,
  input/output Artifact IDs and elapsed time. *(Evidence in the table below.)*
- [x] Inject stop/crash after first idea; restart and confirm the completed
  Artifact is reused, not generated again. `work replay` matches.
  *(Stop: `tests/brainstorm.test.ts` cancels from another process while
  `idea-b` runs; `work retry` reruns only `idea-b` and `synthesis`, and
  `proposal-a` stays the same Artifact. A killed host is the generic takeover
  already covered by the controller and agents tests; not repeated with real
  models.)*
- [x] Test cancellation, unavailable Codex account and changed Workflow file:
  route refusal explicit; old Work retains admitted spec and output IDs.
- [x] Re-run existing code and research smoke tests after adding account
  capability labels.

**Gate:** real three-attempt run and recovery pass; no accidental
same-provider substitution for the two independent perspectives.

### B3 — Brainstorm daily-driver evaluation

- [x] Try at least five varied briefs (architecture, tradeoffs, feature
  design, failure analysis and open-ended ideation). *(Five open questions
  about System itself; table below.)*
- [x] Compare a single-Worker baseline to the three-role workflow. Record
  operator usefulness, novelty, diversity, actual disagreements, latency,
  usage observations (or `unknown`) and manual interventions.
- [x] Capture operator feedback as evidence Artifacts where useful. A model
  self-scoring quality is not sufficient evidence of better decisions.
- [x] Only optimize role/tier selection or add optional critique on observed
  limitations. No team ballots or debate rounds without demonstrated need.
- [x] Compare, as the PR #2 review suggested, a stance per proposal
  (pragmatist, skeptic) with one shared prompt, and a Codex synthesis with a
  Claude one, using the config in
  [workflows/experiments](workflows/experiments/README.md). Score blind:
  the operator reads outputs without knowing the arm or the provider.
  Criteria, 1 to 5 each: usefulness for a decision, diversity of the
  proposals, critical thinking (wrong assumptions, blind spots),
  actionability, and whether the extra attempts were worth their time and
  tokens. *(Scored blind by a Claude Sonnet subagent at the operator's
  request, not by the operator; see [RES-0008](docs/research/RES-0008-brainstorm-evaluation.md).)*

**Gate:** a report of real tasks and measured trade-offs, not just a demo.

### B4 — Focused reliability (may run alongside B1–B3)

- [x] Keep and extend multi-CLI same-Work concurrency regression tests
  for the DSH SQLite `busy_timeout` patch. Test lost updates, duplicate
  dispatch and replay after forced termination. *(`tests/concurrency.test.ts`
  also creates the store from scratch every round; `tests/brainstorm.test.ts`
  kills the host mid-step and starts four `work run` at once.)*
- [x] Avoid new process daemon/lease framework unless a minimal reproducer
  demonstrates a correctness defect. Record fixes independently. *(Two
  fixes, each with a red test first: `c9fc13b` store creation, `ccc5dd5` the
  Work lock. No daemon, no OS lock.)*

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

## 3b. Next milestones (decided 2026-11-06)

These follow a grilling session on architecture and roadmap. The terms are
in [GLOSSARY.md](GLOSSARY.md), the host decision in
[ADR-0007](docs/decisions/ADR-0007-one-long-lived-host.md), and the
principles in [Charter philosophy](docs/requirements/purpose.md#philosophy)
items 8, 11 and 12.

### Growth and feedback budgets (Charter 11 and 12)

Growth is expected. The budgets make it visible and justified; they do not
forbid it. Record the measures at the end of every milestone. Growth above
budget is either justified in the milestone's row or paid for by removal.

| Measure | Baseline (PR #3, 2026-11-06) | Budget per milestone |
|---|---|---|
| Active core: `packages/work/src` + `packages/artifacts/src`, lines | 2,317 | +20% |
| All package source, lines | 4,081 | recorded |
| Docs under `docs/`: lines (files) | 3,571 (37) | +20%, and no fact stated twice |
| Unit check, clean worktree | ~1 min | under 2 min |
| All required checks (`.system/checks.yaml`) | ~7 min | under 10 min |
| Flaky tests known | 0 | 0: a flaky test is fixed before features |
| Tokens per Work | n/a | Fresh input, cache read, cache write, output, recorded per milestone; usage includes every turn of an attempt and, for Claude Code, the CLI's own `costUsd` |

Every milestone ends with a **simplification pass**. A System Work (Sonnet)
proposes deletions and simplifications: dead code, unused abstractions,
duplicated tests, docs that restate others. The operator reviews it like any
PR. After each milestone, the Sonnet code review's Standards axis also checks
the code against Charter items 8, 11 and 12.

### P — Finish PR #3 and small decided items

- [x] Brainstorm default: put the pragmatist/skeptic stances in
  `workflows/brainstorm.yaml`. Keep the one-shared-prompt version in
  `workflows/experiments/` for comparison.
- [ ] Quality evaluations use **Sonnet as the evaluator Worker**, blind
  (operator's choice). Record that the judge shares a model family with most
  writers.
- [x] System publishes its own changes: from the next Work, System's
  Software Engineering Workflow pushes `system/<work>` and opens a draft PR
  on the real repository. It never merges. *(PRs #5 and #6, Works `f7170bdb` and `b2f35f9f`, published in parallel.)*
- [x] A System Work resolves the Dependabot alerts on `main` (9 high,
  2 moderate), verified by the required checks. *(Work `b2f35f9f`, PR #6.)*
- [x] `dev` integration branch ([ADR-0008](docs/decisions/ADR-0008-dev-integration-branch.md)):
  - publish against `dev`;
  - a merge step in `git.publish`, allowed only for an allowlist (`dev`), only
    when the checks passed on the exact head, and recorded as an effect with
    reconciliation;
  - only the operator merges `dev` into `main`.

### H — One long-lived Host (ADR-0007 as amended, PROP-0004 accepted)

Architecture: [Host](docs/architecture/host.md). Components, verdicts and
deferral triggers: [PROP-0004](docs/proposals/PROP-0004-host-design.md).
Every step is a System Work (Sonnet) merged into `dev`, with its tests
written first.

- [x] H1. Controller seam and the deterministic concurrency fixture (barriers,
  seeded delays), with one regression per defect of 2026-11-06. Evidence:
  `packages/work/tests/seam.test.ts` (characterization, barrier cancel,
  seeds 1 to 50) passes before and after the dispatch/execute/observe split.
- [x] H2. Host lock (abstract socket), commit lane, recovery (interrupted
  attempts, uncertain slots, no auto-resume), `commandId` receipts. Evidence:
  `packages/work/tests/host-lock.test.ts` and `host.test.ts` (lock incl. a
  SIGKILLed child, lane, receipts, recovery); the slot itself is H5, so
  `Host.uncertain()` only lists the attempts that will keep one.
- [x] H3. API on a temporary socket (`packages/host`: transport, then the operation table). Evidence: `packages/host/tests/` (`transport`, `operations`, `api`). Includes:
  - the operation table with its `agent` flag and the exclusion test;
  - the version handshake and the caller;
  - `work.events` with a cursor;
  - `host.status` with the memory report.
- [ ] H4. Cutover. Includes:
  - the thin CLI (reads through the Host; Ctrl-C detaches);
  - `system.service` (plain unit, captured PATH, lingering);
  - removing the old mode;
  - the operations runbook with its cutover and rollback checklist (`docs/operations/`);
  - the API reference.
  **Release R1.**
- [ ] H5. Parallel steps and Works with per-Account slots. Barrier tests for
  shared-Account contention and for restarts. **Release R2.**
- [ ] Gate R1:
  - every existing smoke behaviour passes through the Host;
  - a Host killed mid-step recovers on restart, conservatively, and replay matches;
  - an agent caller cannot approve;
  - the guarantees table in host.md has a passing test per row;
  - growth measures are recorded.
- [ ] Gate R2: Brainstorm's two proposals overlap in time, and two Works on
  one Account never run two attempts at once.
- [ ] End of milestone: the two-axis Sonnet review (Charter 8, 11 and 12 on
  the Standards axis), the simplification pass, and the growth record.

### O — Orchestrator and Goal (future ADR)

- [ ] **Goal**: the operator's aim, scope and budget (attempts and observed
  tokens; once spent, new Works for that Goal are refused and running Works
  finish; only the operator raises it). Every Work an Orchestrator creates
  names its Goal. A Goal carries the Charter principles as context for its
  Works.
- [ ] **`system mcp`** (moved from H, ADR-0007 amendment): the agent client
  of the Host's socket, offering only operations flagged `agent`.
- [ ] **Orchestrator**: an agent connected through MCP, a caller scoped to
  one Goal. It may submit, run, cancel and retry, and read Artifacts. It may
  never approve, mark a PR ready, accept an inconclusive verdict or merge.
- [ ] **Completion notices** (operator, 2026-11-06): instead of polling, the
  Host tells a connected Orchestrator when one of its Works changes state,
  for example finishes, is held, or needs approval. Use MCP's own
  server-to-client notifications (resource subscriptions), not a new
  protocol. A notice is only a wake-up: the event log stays the source of
  truth, and a client that missed notices reads on from its last
  `work.events` cursor, so nothing is lost while it was away.
- [ ] Later, not in O: an Orchestrator that System spawns on a schedule.

### W — ChatGPT Website Worker (PROP-0005, after H release R1)

- [ ] Design: [PROP-0005](docs/proposals/PROP-0005-chatgpt-website-worker.md)
  (draft). The operator accepted the Terms-of-Use risk for their own account
  (2026-11-06).
- [ ] Re-run the three research Works (tokens, existing drivers, risks) after
  the verifier fix V1, so their verdicts are not formatting artefacts.
- [ ] Build after R1: the `chatgpt-web` Runtime on Playwright, a dedicated
  signed-in profile, one prompt per attempt, completion detection, answer
  and cited links as outputs, each exchange recorded as a `conversation@1`,
  and deterministic tests on a local fake page.

## 4. After Brainstorm — future, not current gates

- [ ] Website Worker for interactive/browser-assisted Research **only when**
  a real source workflow requires it; keep the same WorkerPort/Artifact IDs.
  *Layer 1 (conversation-to-Artifact ingestion) is being built on PR #3 per
  [PROP-0003](docs/proposals/PROP-0003-conversation-ingestion.md): `system
  conversation add|show`, `task new --context`. Dogfood: the operator's
  ChatGPT review of PR #2 stored as a conversation (`selection: excerpts`)
  and given as context to Brainstorm Work `work:cc9a38a7…` (roles, standard
  tier, 3 attempts, 176 s); the synthesis treated it as operator-supplied
  data and named its uncheckable claims.*
  *Observed need (2026-11-06): the System 1 audit and this roadmap update
  (PR #1 `2dcfe48`) were produced by the operator in ChatGPT on the web and
  carried into the repository by hand, with no Artifact recording what was
  asked and what came back. The B2 Brainstorm Work `work:cad623e9…` is a
  first design comparison for this Worker (summary `sha256:c4eb1e20…`).*
- [ ] Split the Website Worker into three layers (PR #2 review), each its
  own step: (1) **conversation-to-Artifact ingestion**: the prompt, the
  response and metadata from a web session become Artifacts with honest
  provenance, with no browser automation (can be tried early); (2) **source
  fetching and snapshots** with content identity (future Research); (3) the
  **interactive Website Worker** with a signed-in session and recovery
  (after B3/B4). System 1 is a reference for session lifecycle only; no
  persistent team sessions in Work Core.
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
| B0 MVP-0 baseline | done | `41d2e0a` (merge of PR #1) | See the B0 checklist: one concurrency failure at baseline, fixed in B4. |
| B1 Brainstorm YAML | done | `b74f97e` | No Work Core change. `corepack pnpm check`: unit 115/115, smoke 40/42 (2 credential-gated skipped); with `SYSTEM_REAL_AGENTS=1` both pass (a real Claude change; a cancelled Claude attempt taken over by Codex, 132 s). Fake run: three attempts (Claude, Codex, Claude), `idea-a` and `idea-b` inputs are the brief only, `synthesis` inputs the two exact proposal IDs, provenance per Artifact, no verifier, `work replay` matches; refused at submit without Codex; a pinned spec survives an edited file. |
| B2 Real three Worker attempts | done (economy tier) | Work `work:cad623e9-4a65-45ab-bb2d-eb473044811d` | Brief: design a Website Worker. `idea-a` Claude Code 2.1.311 `claude-haiku-5-5` (31 s, 42,940 in / 4,881 out) → proposal `sha256:e0e6c883…`; `idea-b` Codex 0.166.0 `gpt-6-luna` requested (the served model is not reported by Codex; 43 s, 30,148 / 1,783) → `sha256:d2c72a35…`; `synthesis` Claude `claude-haiku-5-5` (53 s, 99,560 / 9,616) → `sha256:c4eb1e20…`, inputs exactly those two IDs. 3 attempts, 0 operator touches, 127 s, `work replay` matches. The synthesis named six real disagreements (session expiry, automatic publish versus operator confirmation, screenshots, partial transcripts, CDP exposure, account check) with the evidence that would settle each. |
| B3 Daily driver evaluation | done (model judge) | `6dc0244` (arms) | 15 Works, all succeeded, 5 hosts in parallel, 35 attempts, 0 operator touches. Tier standard everywhere: Claude `claude-sonnet-5-5`, Codex `gpt-6.1-sol` requested. Arms per brief: S = one Claude attempt (`brainstorm-single`), B = `brainstorm.yaml`, R = `brainstorm-roles.yaml` (Codex synthesis on *failure* and *openended*). Mean per Work: S 37 s, 40k input / 3.4k output tokens; B 157 s, 164k / 10.0k; R 162 s, 152k / 8.9k (about 4× S). Proposal similarity (word cosine of A and B, lower = more different): B 0.52 / 0.59 / 0.57 / 0.48 / 0.36, R 0.53 / 0.50 / 0.44 / 0.43 / 0.39 (mean 0.50 vs 0.46): the stances add a little diversity in 3 of 5 briefs. Blind scores (Sonnet subagent, operator's choice; key kept apart), mean of U/D/C/A: S 3.60, B 4.65, R 4.45. S was never best; R was best on the three briefs with a Claude synthesis, and B beat R where Codex synthesised. Caveats: a model judge from the same family as most writers, five briefs and one run each. Report and recommendation: [RES-0008](docs/research/RES-0008-brainstorm-evaluation.md). |
| B4 Concurrency regression | done | `c9fc13b`, `ccc5dd5`, stale-snapshot fence | Baseline failure reproduced: commands that all find the store missing raced in DSH storage-sqlite (WAL switch "database is locked" despite `busy_timeout`; `UNIQUE constraint failed: units.name`). Patch extended; new test red 9/12 rounds, green 3/3; 300 parallel commands on fresh stores, 0 failures. Review finding (PR #2, P1): `FileControl` created the lock before writing its pid, so a host could read it empty, take it as stale and also acquire the Work. Red test with an empty lock; fixed by linking a complete file (a recent pid-less lock counts as held). Same-Work test: a host SIGKILLed during `idea-b`, then four `work run` at once: exactly one runs, `idea-b` is dispatched once more, every event `seq` kept in order, replay matches; 3/3 runs. A free-lock race between processes did not reproduce the window (microseconds) and stays as a regression test. `corepack pnpm check`: unit 118/118, smoke 41/43 (2 credential-gated skipped). Then (PR #1 review RES-0007, hypotheses confirmed): DSH `storage-domain` serves each host an in-memory snapshot taken at start, so a host that took the lock after another wrote acted on an older record; `retry` also checked before locking and released between reopening and running. Red controller tests (one snapshot per host) for `run` and `retry`; fixed by an event-count fence in `FileControl` and by holding the lock through `retry`/`approve`. `corepack pnpm check`: unit 122/122, smoke 41/43. |

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
