---
id: RES-0006
type: research
status: active
summary: Assess a three-execution Brainstorm Workflow using existing Claude Code and Codex Workers, with exploratory Research flow and Website Worker deferred.
related: [RES-0005, ADR-0002, ADR-0003, ADR-0004]
---

# Brainstorm-first feasibility: three Worker executions, two existing runtimes

**Source review: 2026-11-06. Research hypothesis, not a completed Brainstorm implementation.**
Target: draft [PR #2 at `7099428`](https://github.com/tsuuanmi/System/commit/709942819e56c57452bf72c2db019c845fca1d74).
Its parent docs branch is PR #1. Any change to PR #2 code must be made separately.

## Key distinction

The user wants a **Brainstorm workflow with three Workers/roles**. The
current implementation has **two runtime/account providers**, `claude-code/default`
and `codex/default`. A *third execution* is **not a third provider or plugin**:
the same registered account may execute several independent attempts with
distinct `attemptId`, inputs and output Artifact IDs.

The first composition (the diagram is in
[Brainstorm composition](../architecture/brainstorm-composition.md#current-capability-and-shape))
has two idea steps reading the **same initial brief** without seeing each
other's output, and a synthesis step receiving **exactly the two output
Artifact IDs** (plus the brief). This tests divergent perspectives without
conversation handoff. Each role is a **Workflow step**, not a new singleton
component; a future critique or review step stays optional.

## System 1 as a reference: what to copy conceptually

This section is **a source audit of a different product**, not an instruction
to migrate its engine or import its packages. Reference version:
[`system_1` at `f199a277`](https://github.com/tsuuanmi/system_1/tree/f199a277b2634f8995a499601cbf03616aa639f7).

| System 1 mechanism | Evidence | Adapt for System Brainstorm |
|---|---|---|
| Independent team members propose before seeing others' proposals | [Team design](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/docs/design/teams.md), [`brainstorm` template](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/docs/reference/workflow-templates.md) | **Adopt principle**: the two idea steps receive only the initial brief. Never pass the first output to the second; the third step receives two immutable proposal Artifact IDs. |
| Family/account diversity, recorded fallback | [ADR-0035](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/docs/decisions/adr/0035-one-family-teams-keep-distinct-accounts.md), [team account tests](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/packages/plugins/workflow/tests/team-accounts.spec.ts) | **Adapt small**: use one Claude account and one Codex account for different perspectives. Record the actual route. If distinct providers cannot run, report/fail for the first proof rather than silently execute both as Claude. No generic team routing framework yet. |
| Strict typed proposal/ballot contracts and evidence | [`teams.ts`](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/packages/plugins/workflow/src/teams.ts) | **Borrow tests and output format ideas**: ask for alternatives, rationale, assumptions, objections; store the files and source attempts. Do **not** introduce required `VerifierPort` for idea quality in V0. |
| Sealed ballots, deterministic tally, bounded debate | [Team design](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/docs/design/teams.md), [brainstorm template](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/docs/reference/workflow-templates.md) | **Defer**: useful after measured cases needing consensus or adversarial critique. A vote is advice, not truth or permission to accept/publish. |
| Persistent conversations and team session-affinity | [Team design](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/docs/design/teams.md), [worker sessions](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/packages/plugins/worker-sessions/README.md) | **Do not port**: System's canonical handoff is Artifact IDs; each current native agent attempt is fresh. |
| Two independent literature reviews, evidence table, independent critique, conclusion | [Scientific Research profile](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/packages/plugins/profile-scientific-research/src/index.ts) | **Future Research reference**: valuable composition template when Website Worker and structured research evaluation are in scope. Keep the graph in YAML, not TypeScript plugin registration. |

**Most portable insight:** independent proposals + immutable inputs + explicit
synthesis + provenance. This yields a useful three-attempt flow without
porting `workflow/src/teams.ts`, persistent sessions, member ballots,
dynamic DAG growth, team voting, or a new plugin manager.

## What the implementation supports

Evidence at [`7099428`](https://github.com/tsuuanmi/System/commit/709942819e56c57452bf72c2db019c845fca1d74);
the shipped graph is [`workflows/brainstorm.yaml`](../../workflows/brainstorm.yaml)
and the composition is [Brainstorm composition](../architecture/brainstorm-composition.md).

- External YAML (`dependsOn`, `inputs`, `instructions`, `outputs`) needs no new
  engine for three role steps with Artifact-ID handoff.
- The registry picks the first account meeting a step's capabilities, so
  without different capability mappings all three steps could route to Claude.
  Role-specific `brainstorm.*` labels in the DSH account config need no
  schema change. Codex does not advertise `research`; give it only the role it
  can run. If explicit Worker-ref selection is needed later, add a narrowly
  tested, versioned extension; do not hardcode `claude`/`codex` in the
  Controller.
- The Worker adapter handles `file@1` output from `out/<slot>`, including
  no-Git inputs, so a text brief and Markdown outputs need no code worktree.
- At that commit the controller ran independent branches sequentially (it
  has since gained slots, see [Host](../architecture/host.md)); a workflow
  without `accept` or `verify` ends `succeeded` once its Worker steps do,
  which means execution completed, not correctness or merit.

## What to test before claiming Brainstorm works

Pinned spec, exact input/output references and provenance, three distinct
`attemptId`s, and idea steps not seeing each other's result; a
credential-gated real run recording which models served; kill/restart
without regenerating finished ideas; a YAML edit during a run not affecting
the old Work; Worker failure or cancellation preserving partial outputs and
never reporting success without the synthesis. Most of this is now in
`tests/brainstorm.test.ts` (see
[RES-0007](RES-0007-brainstorm-and-concurrency-review.md)). The part still
open is comparing a few briefs against a **single-Worker** baseline for
novelty, coverage, disagreement, cost/latency and usefulness; three Workers
are a design choice to evaluate, **not proof of superior quality**.

## Does the system need a third Worker?

**Not for the next milestone** ([PROP-0002](../proposals/PROP-0002-post-mvp-roadmap.md#decision-should-we-add-another-worker)).
One Claude account can perform two attempts, Codex one, or vice versa; if one
model gives near-identical perspectives, try different role prompts and
account models first. Do **not** port System 1's monolithic team engine
(session affinity, ballots, dynamic rounds) to coordinate three Artifact-bound
steps. [OpenAI Agents SDK orchestration patterns](https://openai.github.io/openai-agents-python/multi_agent/)
and [Anthropic's research system](https://www.anthropic.com/engineering/multi-agent-research-system)
are external comparison patterns, not dependencies.

## Research workflow versus future Website research

Current Research (a model answers a question, produces `report`/`sources`,
and `research.citation-check` checks sources and quotes) stays operable but
is not proof of report-level claim support. A flow without any verifier needs
a **new versioned workflow file** (a Worker step and outputs, no `accept`
node) and is an execution-result workflow, **not a verified-research
outcome**; keep the existing research YAML and verifier and do not alter
accepted runs' spec hashes. After the next MVP milestone, a Website
Worker/browser-driven research can add interactive or login-gated sources
behind the existing WorkerPort and source Artifact contracts, and then
source snapshots, citations/claim verification and provider-auth constraints
are revisited; verification stays a separately configurable capability.

## Decision

**Research recommendation:** ship a Brainstorm vertical slice using the two
existing runtimes and three Worker attempts before adopting new plugins or
Worker providers. Defer parallel fanout, peer messaging, a full team
framework, claim-level Research validation and Website Worker until a
measured use case. This is an experiment plan, **not** a newly accepted ADR.
