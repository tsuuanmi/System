---
type: architecture
status: active
reviewed: 2026-11-05
decided-by: [ADR-0003]
covers: [packages/artifacts/src/envelope.ts, packages/artifacts/src/canonical.ts, packages/work/src/kinds.ts]
---

# Artifact-ID handoff and pluggable verification

**Accepted architecture semantics; concrete contracts run in draft PR #2.**
The fields and examples in this page include future interface concepts.
The [current artifact package](https://github.com/tsuuanmi/System/tree/973cea6c9e00359519569e3b43a7f809215e518f/packages/artifacts)
and [verifier registry](https://github.com/tsuuanmi/System/blob/973cea6c9e00359519569e3b43a7f809215e518f/packages/work/src/registry.ts)
define implemented behavior. Brainstorm may succeed with **no verifier**:
that means Artifact delivery, not independently validated ideas.
The current Research citation check validates source references/quotes,
not whether every report claim is supported; stronger verification
remains separately configurable future work.
[ADR-0003](../decisions/ADR-0003-artifact-ids-and-verification-contracts.md)
establishes immutable Artifact IDs as the durable handoff protocol between
Workers. Conversation history, transient output paths and model memory are
not the inter-Worker contract.

## Three identities

| Identity | Example notation | Meaning |
|---|---|---|
| Work ID | `work:…` | continuing unit of work, with current lifecycle and outcome |
| Attempt ID | `attempt:…` | concrete Worker execution, retry or reassignment |
| Artifact ID | `sha256:…` | immutable typed content record or manifest reference |

An Artifact ID is *content identity*, not a grant to fetch or export data.
Output slots in workflow configuration are symbolic selectors that are
resolved and pinned to Artifact IDs at execution boundaries.

## Artifact contract: conceptual fields

```text
Artifact:
  id                  content-addressed identity
  kind, schemaVersion  meaning and validation schema
  payload or blobRef   immutable bytes/typed content
  classification      secrecy/egress floor
  inputs[]             Artifact IDs used to derive the result
  provenance          producer attempt, Worker, tool, time, source revision
  subject             exact external object where applicable
  lineage             supersedes / invalidates links
```

The ID computation must use **canonical typed content**, with a documented
hashing and versioning rule, and must not accidentally depend on creation
time or producer identity. Provenance can vary between distinct production
events that yield the same content; record occurrences/lineage separately.
Do not merge confidentiality or authorization solely because hashes match.

**Implemented rule, `artifact-id/v1`** ([`@system/artifacts`](../../packages/artifacts/README.md)):
the ID is `sha256` over the domain tag `system.artifact/v1`, a newline, and the
canonical JSON (sorted keys, RFC 8785 key order) of `kind`, `schemaVersion`,
inline `content` or `blob.{attachmentId, mediaType}`, the sorted set of
`inputs`, `subject` and `lineage.supersedes`. Classification, producer, time
and byte count are outside it. Each record holds the envelope and its list of
occurrences under one storage key; bytes are written to the DSH attachment
store before the record. A change to this rule is a new domain tag, never an
edit of `v1`. Lineage `invalidates`, retention and garbage collection are not
implemented yet.

A derived artifact cannot have a lower data classification than its most
restricted input without a separately authorized declassification decision.
A Worker sees only authorized referenced content, never arbitrary artifacts
merely because it knows their IDs. *MVP-0:* there is one operator and no
per-caller read check; Workers receive only the Artifacts the controller hands
to an attempt (M3).

## Determinism: three separate questions

1. **Content identity:** the same canonical typed content generates the same
   Artifact ID, regardless of producer session/time.
2. **Controller determinism:** given a pinned Workflow spec, recorded
   observations, Worker-routing decisions, input IDs and effect outcomes,
   reconstructing Work state gives the same state. This is replay of
   *records*, not re-execution of remote side effects.
3. **Model/Worker behavior:** LLM output can vary. Treat it as an external,
   nondeterministic observation with its own immutable artifact and
   provenance. Do not assume the Worker will answer identically on retry.

If an input is superseded or its content changes, any verification bound to
an old exact subject becomes stale. A source file path or branch name by
itself is not an immutable result identity; capture the exact tree/commit
and changes being judged.

## Verification capability contract

```text
VerifierDescriptor:
  capabilityId, version
  acceptedSubjectKinds[], acceptedSchemaVersions[]
  criteriaSchema, evidenceSchema
  requiredAuthority and runtime requirements

verify(subjectArtifactId, criteriaRef, policySnapshotRef)
    -> VerdictArtifactId

VerdictArtifact:
  subjectArtifactId
  criteriaRef / hash
  verifierCapabilityId / version
  policySnapshotRef
  verdict: pass | fail | inconclusive | error
  evidenceArtifactIds[]
  provenance (including provider/observations where used)
```

**Implemented (M4):** the contract is `VerifierPort` in
[`@system/work`](../../packages/work/src/registry.ts): criteria are pinned
per Work at admission as an Artifact (a verifier that cannot pin them refuses
the Work), and the controller stores the `verdict@1` Artifact itself after
refusing, as `error`, a verdict about another subject or other criteria, a
`pass` without evidence, unstored evidence, or a subject kind the verifier
does not accept. A verdict whose subject has since been replaced counts as
`stale`. The two verifiers are described in
[`@system/verifiers`](../../packages/verifiers/README.md).

**No single review algorithm is mandatory.** The Work Controller checks
that the configured required verifier capability is available, its subject
and criteria types match, and it returned a verdict on the **same exact
artifact ID and pinned criteria** before accepting the Work.

Examples:

- Software Engineering: tests/check outputs, optional independent code review,
  patch/tree identity and controlled landing approval.
- Research: schema/citation parsing, resolving source references, cited-claim
  consistency, optional independent evidence review and explicit uncertainty.

A verification policy may require multiple capabilities, but must remain
configured rather than hardcoded into the Work Controller. Some verifiers
are pure/deterministic programs; others invoke nondeterministic models.
Both record a typed verdict with replayable input references. A model-based
review is evidence, not mathematical proof of correctness.

**Fail closed:** missing verifier, wrong subject ID, stale criteria,
incompatible schema, absent required evidence or an unverified external
claim is *not* a pass. `inconclusive` is distinct from `fail`.

## Decisions, effects and auditability

Record a decision or event for each consequential route, authorization,
acceptance/rejection and recovery action. Tie decisions to exact artifacts,
policy and verifier versions. Side effects also need operation identities
and reconciliation: content-addressed records alone cannot prevent duplicate
external operations after a crash.

Make artifact retention, garbage collection, read permissions and
content-hash existence leakage part of the audit; deleting underlying
blob bytes while retaining a historical ID must produce explicit
`expired` / `unavailable` state, not pretend the content still exists.

See [workflow composition](workflow-composition.md),
[MVP acceptance](../requirements/mvp.md) and
[research provenance](../research/RES-0004-reference-workflow-artifact-audit.md).
