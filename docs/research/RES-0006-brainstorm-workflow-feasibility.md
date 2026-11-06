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

A sensible first composition is:

```text
Input brief Artifact
   |                        |
   +-> idea-a: Claude ------+-> synthesis: Claude or Codex -> final Artifact
   +-> idea-b: Codex -------+
```

The two idea steps read the **same initial brief** and do not read each
other's output; the synthesis step receives **exactly the two output Artifact
IDs** (plus the original brief). This tests divergent perspectives without
conversation handoff. Each role is a **Workflow step**, not a new singleton
component. A future critique step or review capability remains optional.

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

## What the current implementation actually supports

| Existing implementation | Evidence | Implication |
|---|---|---|
| External YAML, step `dependsOn`, `inputs`, `instructions`, `outputs` | [workflow compiler](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/packages/work/src/workflow.ts) | Three role steps and Artifact-ID handoff need no new workflow engine. |
| Controller chooses first ready pending step | [controller](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/packages/work/src/controller.ts) | Independent branches are **executed sequentially** today; drawing parallel arrows does not mean parallel runtime execution. Do not add parallelism just for V0. |
| Worker registry picks first registered account meeting capabilities | [registry](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/packages/work/src/registry.ts) | Without different capability mappings, all three steps could route to Claude. Add **role-specific capability labels** in DSH account config first; no schema change required. |
| Two configured accounts, Claude with research/web, Codex with code-write and tiers | [bundle config](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/packages/bundle/cordis.patch.yml) | Give both the appropriate `brainstorm.*` capability names by profile patch. Do not claim Codex currently advertises `research`. |
| External Worker adapter handles `file@1` output from `out/<slot>`, including no-Git inputs | [workspace adapter](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/packages/agents/src/workspace.ts) | A text brief and three Markdown output artifacts fit today's file handoff. No code worktree is required for these steps. |
| A workflow **without `accept` or `verify`** can terminate `succeeded` once all Worker steps succeed | [`finishWithoutAccept`](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/packages/work/src/controller.ts) | Brainstorm is possible as exploratory work without a quality verifier, **but** status means execution completed, not factual correctness, approval or intellectual merit. |
| One `Work` persists events/spec/artifacts; retry and replay exist | [Work controller](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/packages/work/src/controller.ts) | Replay uses recorded results; no LLM rerun to reproduce a prior brainstorm. |

## A proposed, currently expressible Workflow configuration

**Illustrative only:** assumes the DSH account config is first extended to
advertise `brainstorm.idea-a` (Claude), `brainstorm.idea-b` (Codex), and
`brainstorm.synthesis` (whichever existing Worker is chosen). These are
configuration labels, **not new Worker implementations**.
The YAML otherwise uses the existing `system.workflow/v1` syntax.

```yaml
schema: system.workflow/v1
id: brainstorm
version: 1
steps:
  - id: idea-a
    capabilities: [brainstorm.idea-a, tier.standard]
    inputs: {brief: "$work.input"}
    outputs: [proposal-a]
    instructions: |
      Explore a distinct solution space. Produce proposal-a with assumptions,
      options, tradeoffs, risks and unanswered questions.
  - id: idea-b
    capabilities: [brainstorm.idea-b, tier.standard]
    inputs: {brief: "$work.input"}
    outputs: [proposal-b]
    instructions: |
      Independently explore alternatives. Do not assume the other Worker's
      conclusions. Include disconfirming arguments and tradeoffs.
  - id: synthesis
    dependsOn: [idea-a, idea-b]
    capabilities: [brainstorm.synthesis, tier.standard]
    inputs:
      brief: "$work.input"
      a: "$steps.idea-a.proposal-a"
      b: "$steps.idea-b.proposal-b"
    outputs: [synthesis]
    instructions: |
      Compare the two proposals, note disagreements, recommend experiments,
      identify decisions requiring the operator, and write synthesis.
```

The schema supports `outputs` as hyphenated slot IDs and resolves the two
symbolic references to immutable Artifact IDs at execution. Make
`brainstorm.synthesis` available on **one** configured account for the
initial fixture. If a later experiment requires explicit Worker-ref selection,
introduce a narrowly tested, versioned config extension rather than
hardcoding `claude`/`codex` in Work Controller.

## What to test before claiming Brainstorm works

1. Register role-specific capabilities via a DSH profile patch without
   changing the Work Controller or creating a new Worker package.
2. Fake-run with two distinct Worker refs and three distinct `attemptId`s;
   validate exact input/output Artifact references, provenance and stable
   dependency ordering. Two independent idea steps must not receive the
   other's result.
3. Credential-gated real run: one Claude idea, one Codex idea, one synthesis
   from the selected account; record which models actually served the calls.
   The agents' success must mean all three files were stored.
4. Kill/restart between idea steps and synthesis; completed idea outputs must
   **not be regenerated**, and the pinned Workflow spec must remain fixed.
5. Change the YAML during a run; old Work uses pinned spec, new Work uses
   new definition. `replay` must match.
6. Report Worker failure/cancellation and preserve partial outputs; do not
   falsely claim successful brainstorm if synthesis was not produced.
7. Show final artifact through existing CLI and compare at least a few briefs
   against a **single-Worker** baseline for novelty, coverage, disagreement,
   cost/latency and operator usefulness. Three Workers are a design choice to
   evaluate, **not proof of superior quality**.

## Does the system need a third Worker?

**Not for the next milestone.** One Claude account can perform two attempts,
Codex one, or vice versa. If the same model produces near-identical
perspectives, try different role prompts and assigned account models first.
Add a new Worker provider only when a real workflow requires a missing
modality/tool/API/provider or measurable diversity unavailable through
existing runtimes, and a compatibility/credential/usage contract is proven.

Likewise, **do not port** System 1's monolithic team/agent-workers engine
just to coordinate three Artifact-bound steps. The audited System 1 team
requires persistent session affinity, ballot/tally contracts and dynamic
round management; none is required for the first System Brainstorm.
[OpenAI Agents SDK orchestration patterns](https://openai.github.io/openai-agents-python/multi_agent/)
and [Anthropic's research system](https://www.anthropic.com/engineering/multi-agent-research-system)
are external comparison patterns, not dependencies or proof of a need for
another provider.

## Research workflow versus future Website research

- **Current Research:** already implemented in PR #2. A model answers a
  question, produces `report`/`sources`, and the existing
  `research.citation-check` checks sources/quotes. **Keep the flow operable**,
  but do not spend the next milestone upgrading claim/source verifiers.
  This check is not proof of report-level claim support.
- **Optional exploratory Research config:** when testing a flow without any
  verifier, use a **new versioned workflow file** consisting of a Worker step
  and output Artifacts. No `accept` node is needed in current `v1`.
  This is an execution-result workflow, **not a verified-research outcome**.
  Retain the existing research YAML and verifier capability; do not silently
  alter accepted historic runs/spec hashes.
- **Future, after the next MVP milestone:** Website Worker/browser-driven
  research can add interactive sources behind the existing WorkerPort and
  source Artifact contracts. At that stage revisit source snapshots,
  citations/claim verification and provider-auth constraints. The browser
  may be needed for login-gated or interactive sites, not merely ordinary
  public web fetch. Keep research verification a separately configurable
  future capability rather than a universal stage.

## Decision

**Research recommendation:** ship a Brainstorm vertical slice using the two
existing runtimes and three Worker attempts before adopting new plugins or
Worker providers. Defer parallel fanout, peer messaging, full team framework,
claim-level Research validation and Website Worker until a measured use case.
This is an experiment plan, **not** a newly accepted ADR.
