---
id: RES-0002
type: research
status: active
summary: Evaluate candidate MVP capabilities against reliability, autonomy, metering and workflow-agnostic evidence without selecting System's architecture.
related: [RES-0001, RES-0003, RES-0004, ADR-0001, ADR-0002, ADR-0003]
---

# MVP selection assessment

**Status: audit hypotheses, not implementation results.**
The product mission, **control-plane role**, DSH/Cordis host, Work/Task
primitive, **config-defined workflows**, Artifact-ID handoff, pluggable
verification and two workflow-agnostic cases are now decided. The [Product Charter](../requirements/purpose.md)
and [MVP contract](../requirements/mvp.md) are authoritative; this page
evaluates the smallest implementation needed to meet them. The
[reference audit](RES-0001-audit-baseline.md) is historical external evidence.

## Selection rule

A capability enters MVP only if it supports the agreed requirements, a safety
boundary, crash recovery or both code and research end-to-end proofs. Choose
the **smallest active DSH plugin composition** with measurable acceptance
criteria. Keep optional code available, but disabled by configuration unless
there is evidence that it is needed. Deletion is a separate, explicit
retirement decision, not how optionality is achieved.

## Preliminary capability disposition

| Capability / concern | Hypothesis | Proof required |
|---|---|---|
| Durable task/artifact identity and persistence | **Required semantics; reuse DSH service if sufficient** | crash/restart state test and readable handoff |
| Worker adapter and capability admission | **Required** | cancel, timeout, replacement and untrusted output handling |
| External workflow file loader and preflight | **Required** | parse two config files, validate dependencies and verifier IDs, freeze resolved spec hash |
| Content-addressed Artifact-ID handoff | **Required** | cross-Worker handoff without transcript, authorized reads, lineage and stable identity |
| Effect journal, idempotency and reconciliation | **Required** | kill at effect boundaries; no blind duplicate action |
| Policy, approvals and egress boundary | **Required; evaluate DSH plugins for reuse** | denied action cannot escape via another path |
| Usage accounting and minimal metrics | **Required** | provider oracle and resumed-session delta |
| Pluggable exact-artifact verification | **Required** | separately configured code-tree and research-report verifiers bound to exact Artifact ID |
| Software Engineering end-to-end | **Required** | test/review/approved outcome with same controller |
| Research end-to-end | **Required** | citations/evidence report with no controller code modification |
| Small DSH/Cordis host composition | **Selected foundation; optimize config** | effective plugin tree, deps, cold start, CPU/RAM and safety |
| Community plugin integration | **Available but gated** | pinned compatibility, permission and provenance checks |
| Optional Website/browser Workers | **Disabled unless needed** | explicit evidence of required use case and reliability |
| Model gateways, expanded UI/reporting | **Disabled unless needed** | cannot complete both fixtures via simpler entry point |
| Auto-start | **Evaluate behind policy** | reduces operator touches without safety regression |
| Feedback platform, large workflow DSL | **Disabled/deferred** | demonstrated product necessity |

"Disabled" is a **configuration and composition state**, not a request to
remove source, uninstall packages or discard community integration.

## Audit workstreams and outputs

1. **DSH inventory:** pin its release, inspect services, bundles, profile
   overrides and which plugin rows mount in the effective configuration.
2. **Minimal capability closure:** map client -> Work -> Worker -> Artifact ->
   verification -> decision; create a profile with no unrelated active rows.
3. **Effect integrity:** test persistence, retry, approvals, egress and plugin
   lifecycle during crash/cancellation/unload.
4. **Metering:** test cumulative resumed-session usage against an oracle and
   distinguish missing data from zero usage.
5. **Composition experiments:** disable/re-enable plugins, verify config-layer
   precedence and fail-closed behavior on missing required services.
6. **Cross-domain proof:** run Software Engineering and Research via the
   same work core and swap adapters under a compatible contract.
7. **Decision:** retain only proven System-specific mechanisms and record
   which DSH services implement the rest.

## MVP proof matrix

| Test | Expected proof |
|---|---|
| T1 Two workflow files | Software Engineering and Research configs use identical Work Core without source changes |
| T2 Crash/restart | killed process resumes or reconciles with no blind duplicate effect |
| T3 Trust boundaries | denied tool, credential abuse and forbidden egress blocked |
| T4 Accounting | session resumes without double-counted usage |
| T5 Verification | exact Artifact ID, configured verifier capability, criteria version and evidence |
| T6 Replaceability | a compatible Worker can take over from Artifact IDs, without transcript or engine modification |
| T11 Config snapshot | workflow file edit/removal does not alter admitted Work; replay uses persisted decisions |
| T12 Single Task | Work without a Workflow config runs without public DAG machinery |
| T7 Plugin configuration | optional plugin disabled without deletion; effective state verified |
| T8 Plugin unload | in-flight work drains, holds or safely reconciles |
| T9 Runtime overhead | cold start, memory, service count and latency measured |
| T10 Operator autonomy | accepted tasks and approval requests instrumented |

These are **test plans**, not passing results. Historical reference
targets R1–R5 are candidate benchmarks, not pre-adopted System release gates.

For pinned-source findings and **adopt / adapt / defer / reject**
dispositions, see [RES-0004](RES-0004-reference-workflow-artifact-audit.md).

## Audit acceptance

Deliver a scored **reuse / thin wrapper / implement / disable** table with
upstream source and version, active dependency closure, observed behavior,
tests, measured overhead and risks. Review against
[ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md) and the
[MVP contract](../requirements/mvp.md), then accept the remaining
implementation designs explicitly.

Avoid tracked PLAN.md/TODO.md/STATUS.md copies that duplicate canonical
decisions, project tasks or verified validation records.
