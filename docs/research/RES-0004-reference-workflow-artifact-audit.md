---
id: RES-0004
type: research
status: active
summary: Audit reference workflow, artifact, Worker and plugin implementations; identify transferable mechanisms and pitfalls for config-defined workflows and exact-artifact verification.
related: [RES-0001, RES-0002, RES-0003, ADR-0002, ADR-0003]
---

# Reference audit: workflows, artifacts, verification and plugins

**Research, 2026-11-05. Non-normative.** The observed repository
([pinned reference commit](https://github.com/tsuuanmi/system_1/tree/053c99678c30faad0aa8fab6ae8e850052c7ce6a))
is an *external audit target*, not the new System's lineage or selected
codebase. Findings below distinguish source code, documented target and
unverified live behavior. We examined representative docs and plugin files at
commit `053c9967` on its `docs/production-direction` branch; no live runtime
or crash test has been performed here.

## Reusable mechanisms: source evidence

| Mechanism | Pinned source evidence | Value and caution |
|---|---|---|
| Templates, steps and capabilities | [workflow plugin](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/packages/plugins/workflow/README.md), [NodeTemplate](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/packages/plugins/workflow/src/spec.ts) | Adapt explicit dependencies, capabilities and acceptance contracts. The new system requires **independent config files**, not domain steps registered in TypeScript. |
| Workflow admission | [workflow design](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/docs/design/workflow-engine.md), [spec source](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/packages/plugins/workflow/src/spec.ts) | Adopt preflight of unique steps, dependencies and cycles; canonicalize and hash the resolved spec before dispatch. |
| Artifact IDs and lineage | [artifacts design](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/docs/design/artifacts.md), [artifacts implementation](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/packages/plugins/artifacts/src/index.ts), [conformance summary](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/packages/plugins/artifacts/README.md) | Adopt immutable typed input/output IDs, lineage, sensitivity floor, separate producer occurrences and explanations. Verify byte-level hashing and access control. |
| Exact-subject review | [workflow plugin](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/packages/plugins/workflow/README.md) | Reviewed code subject includes HEAD plus changes, not a mutable branch name. Generalize to any Artifact ID plus criteria hash. |
| Explainable routing | [workers plugin](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/packages/plugins/workers/README.md), [implementation](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/packages/plugins/workers/src/index.ts) | Adopt capability matching and decisions with rejected candidates and reasons; defer elaborate provider/quota optimization until measured. |
| Registered acceptance | [workers contract](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/packages/plugins/workers/README.md) | Adapt registry of verifier capabilities; an answer containing text or an http(s) link does **not** prove factual correctness. |
| Cross-domain engine reuse | [research profile](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/packages/plugins/profile-scientific-research/README.md), [source](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/packages/plugins/profile-scientific-research/src/index.ts) | The reference reports a research profile without engine changes, using registered templates, schemas and contracts. Go further: whole workflow graph comes from a config file. |
| Composition manifests | [plugin host](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/packages/plugins/plugin-host/README.md), [manifest sample](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/packages/plugins/workflow/plugin-manifest.json) | Adopt provided/consumed seam versions and explicit effective config checks. Important gap: a bad manifest can mark health down while the plugin **still mounts**; ensure fail-closed Work admission. |
| Product-scope restraint | [lean-core research](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/docs/research/lean-core-2026-11-01.md), [PROP-0022](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/docs/proposals/0022-lean-core.md) | Keep the active composition small. Historical latency, autonomy and accounting figures belong to the external installation, not fresh System. |

## Adopt / adapt / defer / reject

| Pattern | Disposition | Reason |
|---|---|---|
| Immutable content-addressed artifacts, ID refs and lineage | **Adopt semantics** | Durable inter-Worker handoff, trust labels and exact-subject verification. |
| Resolved spec validation and frozen config hash | **Adopt semantics** | Running Work must not drift when an external file changes. |
| Capability-based Worker routing and reasoned decisions | **Adapt** | Keep Worker-agnostic admission; begin with simple deterministic ranking. |
| Templates defined in TypeScript code or contributed by domain-profile plugins | **Adapt, do not inherit** | System workflow steps/order are external YAML data, not codebase/domain module structure. |
| Acceptance/verification registry | **Adapt** | Typed verifier capability with explicit exact subject, criteria, result evidence and version. No universal review chain. |
| Registered schema and source-constrained result types | **Adapt** | Refuse missing schemas, but keep schema validity distinct from factual verification. |
| Plugin lifecycle manifest records | **Adapt with stronger gates** | Dependency health reports alone do not enforce safe mount/unload or new Work admission. |
| Workflow-global review remediation, debate, votes and team expansion | **Defer** | These are optional workflow capabilities, not required controller transitions. |
| Large board/UI, automatic Website Workers, experimentation platform | **Defer; config disabled** | Preserve ecosystem reach without burdening the MVP active profile. |
| Same model output on replay, trust in URL-as-evidence | **Reject** | Generated output is nondeterministic; citation existence is not citation support. |

## Findings that need special care

**Not fully file-backed:** the reference accepts config `templates`, but
built-ins and domain-profile packages can also define `NodeTemplate` arrays
inside TypeScript and register through `ctx.workflow.template`. A reusable
System workflow file must be loadable and changeable without editing or
recompiling the Work Controller. DSH profile/bundle config still separately
controls installed/enabled *capabilities*, not workflow step order.

**Not all target features are implemented:** the reference artifact design
states that large bodies are inline and blob storage is planned. It also
documents some planned admission/lineage semantics. Its plugin host documents
that a manifest finding may mark health down while the row still runs.
These are issues to verify with tests, not reasons to copy implementation.

**Determinism is layered:** a model-driven decision explicitly carries
`deterministic: false` in the reference design, while controller routing,
artifact content identity and stored decisions can be reproducible.
Replay must use recorded results instead of re-calling an external model
or blindly repeating an effect.

**Verification has variable quality:** the reference's
`acceptance.answer` checks text existence and `acceptance.cited` checks
for an http(s) link. Its research-specific contract checks further structure,
but a valid link alone cannot prove the underlying claim. System needs
distinct verifier capabilities for schema, source availability, citation
support and exact subject identity; independent model review is configurable.

## Independent external comparators

- [Dagu](https://docs.dagu.sh/writing-workflows/): a Workflow can be YAML
  with `steps` and `depends`, including a minimal single-command case.
- [Argo Workflows](https://argo-workflows.readthedocs.io/en/latest/workflow-inputs/):
  downstream tasks explicitly consume prior output artifacts; System should
  bind symbolic output slots to immutable Artifact IDs.
- [Temporal replay](https://docs.temporal.io/workflows): deterministic
  workflow state follows persisted event history, not recreating external
  nondeterministic observations.
- [Temporal idempotency](https://github.com/temporalio/documentation/blob/main/docs/best-practices/error-handling.mdx):
  remote effects may have succeeded before a Worker crashes; retry safety
  is a separate guarantee.
- [in-toto specifications](https://in-toto.io/docs/specs/):
  attestation-style binding of evidence to exact subjects is useful
  inspiration for typed verification; not an MVP dependency.

## Falsifiable experiments for System

The experiments are now the acceptance and failure tests of the
[MVP contract](../requirements/mvp.md#failure-and-governance-tests) (two
workflow files on one controller, a Task without a file, a pinned spec under
a config edit, stable content IDs with separate provenance, cross-provider
Artifact handoff, fresh verification when a subject changes, unknown or stale
verifiers, a crash between effect and receipt, plugin disable) plus these
two: a source URL without actual evidence must not pass, and the actual
active plugin graph, cold start, overhead, operator touches and
accepted-result latency are measured.

Exact YAML schema, artifact hashing/canonicalization, storage/backend,
effective DSH profile, verification isolation and crash semantics remain
**unresolved engineering details**. This is a source-backed audit plan, not
a runtime validation report.
