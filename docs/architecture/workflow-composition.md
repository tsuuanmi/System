---
type: architecture
status: active
reviewed: 2026-11-05
decided-by: [ADR-0002, ADR-0006]
covers: [packages/work/src/workflow.ts, packages/work/src/record.ts, workflows/*.yaml]
---

# Work primitive and declarative Workflow composition

**Accepted architecture; `system.workflow/v1` is implemented** by
[`@system/work`](../../packages/work/README.md); its compiler and the
[executable configs](../../workflows/README.md) are the authority for exact
v1 syntax. The examples below are conceptual sketches, **not runnable v1
examples**. The [Brainstorm composition](brainstorm-composition.md) adds a
third domain without a new controller. Work/Task
is the basic durable unit. A Workflow is a versioned **config file** interpreted
by a single generic Work Controller; it is not a code module per use case.
The decision is [ADR-0002](../decisions/ADR-0002-work-primitive-configured-workflows.md).

## Ownership and lifecycle

| Concept | Responsibility |
|---|---|
| Work/Task | durable identity, objective, outcome, current status, artifact refs |
| Attempt | one Worker execution against frozen input references |
| Workflow definition | ordered/dependent steps, capability requirements, artifact mappings, verification policies; external data |
| Admitted workflow snapshot | canonical resolved config and its hash/Artifact ID used by one run |
| Worker adapter | obtains authorized artifact inputs, executes a step, returns Artifact IDs and observations |
| Verifier capability | checks an exact artifact against versioned criteria and records verdict |
| DSH composition | decides which plugins/services/Worker adapters are actually enabled |

**Normal single Task:** one direct admission -> execute -> produce artifact ->
verify if required -> terminal outcome. It does **not** need a user-authored
workflow YAML or a multi-node DAG.

**Configured Workflow:** one Work may encompass dependent steps. Runtime
creates subordinate attempts or internal step records, but preserves a
single accepted config version for that run. The config is read from an
external file, validated, canonicalized and recorded at admission.

## Authoring vocabulary

Configured Worker IDs may be hints; default selection is capability-based,
never hardcoded to a vendor. Bounded time, retry and concurrency policies are
added only where necessary.

## The implemented vocabulary: `system.workflow/v1`

Top level: `schema: system.workflow/v1`, `id`, a positive integer `version`,
and 1 to 32 `steps`. Each step has an `id`, optional `dependsOn`, and exactly
one form:

| Form | Fields | Meaning |
|---|---|---|
| Worker step | `capabilities`, `outputs`, optional `inputs` (`name: $work.input` or `$steps.<step>.<slot>`), optional `instructions`, optional `retry`, optional `mayBeEmpty` | one Worker attempt; each output slot must name a stored Artifact; `instructions` (up to 8 KiB) tell the Worker what this step needs, such as an output format |
| verify step | `verify: {capability, subject, criteria, inputs?, holdInconclusive?}` | one verifier call on the exact Artifact the `subject` reference resolves to; `inputs` (as a Worker step's) hands it further exact Artifacts, such as the report beside the sources; `holdInconclusive: true` holds the Work at this step for the operator on an `inconclusive` verdict (see Operator decisions) |
| effect step | `effect: {capability, subject, requires: [verify steps], params?}` | one external effect of the exact subject, only after every required verdict on that subject is `pass`; recorded as intent, then outcome |
| accept step | `accept: {requires: [verify steps], approval?: operator}` | the terminal decision; at most one, and last |
| uses step | `uses: <file>`, optional `inputs: {input: <ref>}`, optional `outputs: {<slot>: $steps.<step>.<slot>}` | a Sub-workflow ([ADR-0002 amendment](../decisions/ADR-0002-work-primitive-configured-workflows.md)): the steps of the Workflow file beside this one, joined at admission |

**Model tiers are capabilities.** A step asks for `tier.economy`,
`tier.standard` or `tier.frontier` beside its other capabilities; an agent
account offers the tiers it has a model for. Routing never names a model.

**Sub-workflows** are joined by the compiler before preflight, as GitHub
Actions' composite actions are expanded in place. A `uses` step is replaced
by the used Workflow's steps, their IDs, references and requirements under the
using step's ID (step `checks` of `code-checks.yaml`, used by step `checks`,
becomes `checks.checks`). `inputs.input` is what the Sub-workflow reads as
`$work.input` (default: the using Workflow's input), and `outputs` names the
outputs the using Workflow reads as `$steps.<uses step>.<slot>`. A `dependsOn`
on the using step means all its steps; `requires` names joined steps by their
full ID. Refused: recursion (a Workflow ID already in the chain), more than
three levels, a Sub-workflow with an accept step, a step ID with a `.`, more
than 32 steps once joined. The resolved spec has no `uses` left, so the
controller, replay, per-step retry, slots and budgets apply as written. The
CLI sends each used file it finds beside the using file, with the Workflow; a
file not sent (not beside it, or an MCP caller's) is read by the Host from
`workflows/` at the input Task's base commit, else from the `workflows/` beside
its own code. The CLI's `usedFiles` ([packages/app/src/remote.ts](../../packages/app/src/remote.ts))
leaves the rest to the Host and does not read them itself.

Preflight refuses, before any Worker runs: unknown fields, YAML duplicate keys,
another schema version, duplicate steps, unknown or self dependencies, cycles
(with their path), a reference to a step the step does not depend on or to an
output that step does not declare, an accept step on a non-verify step, more
than one accept step, and any Worker or verifier capability the **effective**
composition does not provide.

The repository's files are [`workflows/feature.yaml`](../../workflows/feature.yaml) (the default for a code change), [`workflows/software-engineering.yaml`](../../workflows/software-engineering.yaml),
[`workflows/research.yaml`](../../workflows/research.yaml) and
[`workflows/brainstorm.yaml`](../../workflows/brainstorm.yaml). They differ
only in capabilities, output slots, instructions and verifier; Brainstorm has
none, and routes its two independent proposals to different providers through
role capabilities (`brainstorm.idea-a`, `brainstorm.idea-b`) that the profile
gives to one account each. Since RES-0008 the two proposals also take
different stances (pragmatist and skeptic) through their step instructions;
the one-shared-prompt variant is kept in `workflows/experiments/`. Compared with the earlier
sketch, `inputs` binds Artifacts explicitly, `version` is required, and
`approval: operator` replaces `operator-merge`, because System never merges
(ADR-0004 decision 10).

The resolved spec is the validated workflow with its steps in a stable
dependency order (file order among ready steps) and each `dependsOn` sorted
and deduplicated, so how dependencies are written never changes the spec. It
is pinned as an Artifact of kind `workflow-spec@1`; its Artifact ID is the
spec hash. A direct Task without a file is the same spec with one implicit
step `task`, output `result`.

**Criteria** are pinned per Work at admission: each verify step's verifier
turns the `criteria` name into an Artifact, recorded on the Work, or refuses
the Work. **`system work retry --step <id>`** reruns a Worker step of failed,
cancelled or held Work and resets every step after it, so a verdict never
outlives its subject. On a verify step it asks the verifier again on the same
subject with the same pinned criteria (PROP-0006 "verify again"), as after a
check failed for a reason outside the change; only a human asks it, so no
agent keeps the luckiest of several runs; the earlier verdict stays in
the record and no longer counts.

**`retry: { onFail: [<step>...], max: n }`** on a Worker step (Item df-7) is
the one automatic further attempt, declared in the Workflow and the same for
every domain. `onFail` names the verify steps that judge the step's output or come after it
and depend on it (a `fail` verdict qualifies; `error` and `inconclusive` do not) and the step
itself (a failure its Worker marked `retryable` in its result, which only the
Worker can know: it happened before anything was sent that cannot be sent
twice). The controller then appends `reopened` with `automatic: true` and no
caller, at most `max` times per verify step in `onFail` (and for the step
itself), counted from the recorded events so a restart or another Account does
not reset it. When several steps list the failing verify step, the controller
reopens the one latest in dependency order that has budget left; its
downstream steps run again. After a failing verdict the new
attempt gets the verdict Artifact as input `failure` (its reason and evidence
IDs) and the change as `previous`; after a Worker failure it starts fresh with
neither. A later Worker step may also be in `onFail`: when its final message has a line
`OBJECTION: <what and why>`, that step fails with the text as its reason, and this step is
reopened (budget counted per objecting step) with a `fail` verdict Artifact holding the text as
input `failure`; a step no other step lists cannot object. Anything else, and every later
failure, is the operator's `work retry`.
It is no operator touch in `work report`.

**Effects** (ADR-0004 decision 10): an effect step's provider validates its
`params` at admission. Before `apply` the controller records
`effect-intended` with an `operationId` stable for the Work, step and subject;
after it, `effect-observed`. A lost host or a failed `apply` leads to
`reconcile`, which only reads the remote: `applied` is recorded, `absent` is
applied again, `unknown` holds the Work until a later run reads a definite
outcome. An effect is never retried blindly, and runs only on a `pass`.

**Operator decisions:** Work held for an inconclusive verdict, an effect that
needs approval, or `approval: operator` records the step it awaits.
`system approve` / `system deny` record a `decided` event and run on or fail
the Work; they need a human at a terminal (ADR-0004 decision 3).

**Outcomes:** every step done and every required verdict `pass` is
`succeeded`; any `fail` or `error` verdict, a failed step, or a Worker missing
at run time is `failed`; an `inconclusive` verdict or `approval: operator` is
`held` for the operator. Missing evidence is never a pass, with or without an
accept step. A `fail` or `error` verdict that no `retry` reopens ends the Work
there: no step after it starts, so nothing builds on or publishes what failed
its check (df-26); an `inconclusive` one lets the steps after it run, unless the
verify step sets `holdInconclusive`: the Work is then held at that step (`awaiting`
it) before any step after it starts (dg-2; `red` sets it).

## Deterministic admission and replay boundary

Admission validates and resolves the config against the **effective DSH
plugin composition**, then persists the content-addressed resolved spec and
records its Artifact ID on the Work before dispatch
([ADR-0002](../decisions/ADR-0002-work-primitive-configured-workflows.md)
decision 5). Worker choice and step aliases resolve against actual Artifact
IDs, with the choice and reason persisted before its effects. Replay uses
recorded result IDs, verifier evidence, decisions and external observations,
**not** a rerun of Worker reasoning
([determinism](artifact-verification.md#determinism-three-separate-questions)).
Editing the YAML never mutates a running Work's spec; removing it disables
only **new admissions**; only an explicit migration or decision may rebind a
live Work, and it must invalidate affected downstream verification. An
uncertain remote effect is held or reconciled before any retry; workflow
structure alone cannot guarantee exactly-once effects.

**Implemented recovery:** each Work is one storage key holding its events
(`admitted`, `dispatched`, `observed`, `verified`, `attempt-lost`, `terminal`)
and the state they fold to; every change is one atomic update. A step whose
last attempt was dispatched but never observed is recorded `attempt-lost` and
dispatched again as a new attempt with the same recorded inputs; completed
steps are never re-run. `system work replay` folds the events again and
compares the result with the stored state.

DAG support should emerge from `dependsOn` only. Do not require a
DAG-specific user abstraction for a one-step task.

## Config is not capability installation

Workflow YAML only requests capabilities DSH profile/bundle config has
already activated; it cannot enable an untrusted Worker, install a package,
grant egress or approve an effect. A capability disabled in DSH config makes
dependent admission fail with a clear missing-capability reason
([control plane](control-plane.md#kernel--active-composition-rule)).

See [Artifact-ID handoff](artifact-verification.md),
and [MVP requirements](../requirements/mvp.md).
