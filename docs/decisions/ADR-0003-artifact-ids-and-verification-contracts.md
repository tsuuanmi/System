---
id: ADR-0003
type: decision
status: accepted
date: 2026-11-05
summary: Require immutable Artifact-ID handoff, deterministic orchestration from pinned inputs and persisted decisions, and pluggable exact-subject verification contracts per workflow.
related: [ADR-0001, ADR-0002, RES-0004]
---

# Artifact IDs are the handoff protocol; verification is pluggable

## Context

Workers may use different models, conversations, tools or machines and may
produce nondeterministic responses. A trustworthy control plane cannot
rebuild the handoff by relying on a model's prior conversation or a mutable
workspace path. At the same time, Software Engineering and Research have
different evidence requirements; forcing every workflow through one review
pipeline would couple the core to a domain.

## Decision

1. **Artifact-first handoff.** Every durable inter-Worker result and the
   inputs of subsequent steps are addressed by **immutable Artifact IDs**,
   not by copying previous Workers' conversations or assuming a mutable path.
2. **Separate identities.** `workId` names the continuing task; `attemptId`
   names a concrete execution; `artifactId` names an immutable, typed,
   content-addressed data object; a verification record names what was
   checked. These are not interchangeable. Equal content can be reused,
   with production/provenance recorded separately.
3. **Deterministic orchestration, not deterministic AI.** Given the same
   pinned workflow spec, recorded external observations/decisions and
   artifact references, the controller must reconstruct the same work
   state and dispatch/acceptance history. It must **not** expect a model
   call to reproduce identical text. Re-execution is a new attempt with
   recorded inputs and outcomes; completed external effects are not
   silently repeated.
4. **Typed artifact envelope.** Every artifact exposes schema/version,
   content identity, classification, producer provenance, input IDs and
   retention policy. Content hashing uses a defined canonicalization
   process and domain separation; exact algorithm/envelope version
   remains a design decision. Timestamps and runtime IDs cannot
   accidentally destabilize content identity.
5. **Data confidentiality follows lineage.** Input classification imposes a
   minimum classification on derived outputs. An Artifact ID conveys
   identity, **not read or egress permission**. Access must be checked
   separately, including when content is deduplicated between runs.
6. **Verification is a capability contract, not one fixed review process.**
   A verifier advertises a capability and accepted result types, receives
   an exact subject Artifact ID (plus criterion/configuration version),
   and emits a typed verdict with evidence and provenance. Unknown
   verifier/capability fails admission when required.
7. **Workflow chooses appropriate verification.** A code workflow may
   require tests, static checks and independent review of an exact commit.
   A research workflow may require reference resolution, citation
   consistency and claim/evidence checks. Independent model review is
   optional or policy-required **per workflow**, not a universal engine rule.
8. **Acceptance binds to exact subject.** The control plane accepts only
   when required verifier results refer to the same immutable subject,
   applicable criteria and valid policy snapshot. Changed output or
   invalidated input requires new verification. Missing evidence is
   never treated as passing.
9. **Decisions are traceable.** Routing, effect authorization, acceptance,
   manual approval and recovery retain their reason, input references,
   policy/verifier version and result. A model verdict is recorded as a
   nondeterministic observation, even when its record is immutable.

## Consequences

- An Artifact Store and a verifier registry may reuse existing DSH services
  if tests prove the required semantics. A new competing full subsystem is
  not prescribed.
- Content addressing, cryptographic verification and deterministic replay
  are distinct properties. Having a SHA-256 ID does not establish factual
  correctness or exactly-once external side effects.
- Artifacts can store or refer to large blobs; the manifest/ref and
  access-control semantics must remain testable.
- Workflow config selects capability identifiers and acceptance policies,
  not hardcoded verifier implementation classes.
- No claims of successful implementation are made by accepting this ADR.

See [artifact and verification boundary](../architecture/artifact-verification.md)
and [reference audit](../research/RES-0004-reference-workflow-artifact-audit.md).
