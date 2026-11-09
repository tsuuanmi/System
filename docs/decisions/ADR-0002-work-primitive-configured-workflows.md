---
id: ADR-0002
type: decision
status: accepted
date: 2026-11-05
summary: Make Work/Task the execution primitive and Workflow an external, versioned configuration composition of steps, dependencies, Worker capabilities and verification policies.
related: [ADR-0001]
---

# Work is the primitive; Workflow is configuration

## Context

System is a work control plane on DSH/Cordis
([ADR-0001](ADR-0001-control-plane-on-dsh.md)). Its work identity must survive
changes in Worker, runtime, workflow definition or DSH plugin composition.
The first two mandatory domains are Software Engineering and Research.

The reference audit (RES-0004, retired; [ledger](../governance/retired.md))
shows that configurable templates, preflight and spec hashes are useful, but
some reference workflow definitions still live in TypeScript plugin code.

## Decision

1. **Work (a Task) is the core primitive.** A single Task can be admitted,
   assigned, completed and verified without creating an explicit DAG. Work
   identity and lifecycle are independent of workflow authoring.
2. **Workflow is declarative composition, not an engine, plugin or source
   code component.** A separately versioned configuration file (initially
   YAML as the preferred human-readable representation) declares steps, their
   dependencies/order, accepted inputs and outputs, required Worker
   capabilities and verification policies.
3. **A generic interpreter executes the composition.** A sequential list
   is enough for linear work; dependencies form a DAG only when needed.
   Scheduling, capability admission, artifact binding and safe recovery
   are common Work Core mechanisms for both domains.
4. **Workflow files are runtime/deployment data.** They can be supplied by a
   repository or installation and replaced without recompiling System.
   Source code defines the interpreter and plugin contracts, not
   `software-engineering` or `research` step graphs.
5. **Admission freezes an executable version.** Validate fields, unique
   steps, dependencies, cycles, capabilities, verifier availability,
   authority, schema references and bounds before dispatch. Canonicalize
   and pin the resolved config as a content-addressed spec artifact; each
   Work execution records its admitted spec ID/hash. A later file edit
   only affects new Work, unless a separately authorized and recorded
   migration is performed.
6. **Artifact refs, never transcript copying, connect steps.** Human-friendly
   expressions such as `$steps.prepare.outputs.notes` resolve to exact
   Artifact IDs before Worker dispatch. Runtime execution never depends
   on a mutable named output or unpinned latest result.
7. **Policy cannot be weakened by workflow config.** A workflow requests
   capabilities; it cannot grant credentials, egress or tool rights.
   Verification selection likewise cannot silently bypass mandatory
   safety/acceptance gates.
8. **DSH configuration and workflow configuration are distinct.** DSH
   profile/bundle config chooses which services/plugins are mounted.
   Workflow files declare what the Work does using the capabilities
   actually available. A workflow cannot enable plugins implicitly.

## Consequences

- A one-step task remains cheap: no forced explicit DAG, team, board or
  planner object. A Work Controller may internally represent one node.
- A new workflow does not require a new domain plugin or source changes.
- Configuration-only changes are still governed inputs: require validation,
  traceable provenance and a frozen version.
- A removed config file does not erase accepted runs or their provenance.
- YAML is a preferred authoring format, **not yet a frozen schema/version**;
  exact syntax and loader behavior require an implementation spike.
- Dynamic graph growth, loops, compensation, conditionals and complex
  scheduling are deferred until concrete use cases demonstrate necessity.

## Amendment (2026-11-07): Sub-workflows, joined at compile time

The operator decided that a Workflow may use another Workflow as one of its
steps (a Sub-workflow, [GLOSSARY](../../GLOSSARY.md)). Standards considered:
GitHub Actions' composite actions (expanded in place) and reusable workflows
(run as separate runs); System takes the composite model.

- A step `uses: <workflow file>` with `inputs` and `outputs` mappings is
  expanded by the Workflow compiler when the Work is admitted: the
  Sub-workflow's steps join the spec under the using step's namespace (for
  example `debate.round1.a`), and the expanded spec is pinned as any other.
- The controller is unchanged: replay, Artifact IDs, per-step retry, slots
  and Goal budgets apply to the expanded steps as written.
- No recursion; a bounded depth (3). A Sub-workflow still runs on its own as
  an ordinary Workflow.
- Rejected for now: a step that submits a child Work and waits for it. It
  needs parent and child Work in the core (cascading cancel, budgets, restart
  recovery), a new layer Charter 11 asks to avoid until a need shows.

See [workflow composition](../architecture/workflow-composition.md) for the
target boundary and illustrative domain-neutral YAML, and
[MVP acceptance](../requirements/mvp.md) for tests.
