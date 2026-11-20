---
id: ADR-0013
type: decision
status: accepted
date: 2026-11-20
summary: Models decide what to try; deterministic checks decide what is accepted. A model may choose what to try next and may block (fail or inconclusive), never accept; every model decision is an Artifact; Triage v1 only writes a diagnosis and a hold recommendation; a Model check runs in shadow until its precision is measured.
related: [architecture/host]
---

# Models decide what to try; deterministic checks decide what is accepted

Accepted 2026-11-20 by the operator (Intent 6bb1d7c3f7a5, Item ir-1).

## Context

- The Classifier's gate failed twice: the hybrid reached 63.4%, below the
  rules (PLAN RB).
- 64% of 130 failures recurred across 328 Works since 2026-11-10.
- Rules held only in prose drifted (the DP core budget).
- EV's research (`work:69bea86a`) found no evidence for model review as a
  merge gate.

## Decision

1. **A model chooses, a check accepts.** A model may choose what to try next
   and may block (a Verdict of fail or inconclusive). It never accepts.
2. **Every model decision is an Artifact.** Replay reads the record, never the
   model (ADR-0003 §9).
3. **Triage v1 is small.** It only writes a diagnosis that the reopened step
   reads, and a hold recommendation. The controller is unchanged.
4. **A Model check runs in shadow** until its precision is measured.

### Supersedes

- TR's "never a model review" (PLAN §0, 2026-11-14): a model check may block,
  in shadow first.
- cls-1's "nothing routes, retries, holds or verifies on a Classification",
  for Triage only (cls-1, 2026-11-16/17).

### Stays in force

- RO's "only a human verifies again" and "no recovery-decision component in
  the core" (PLAN §0).
- [ADR-0012](ADR-0012-host-carries-works-on-never-picks-items.md): model
  judgement does not move into the Host (EV, 2026-11-18).

## Consequences

IR batches 2 and 3 (warnings, `guardrail.yaml`, a Model check of Done when,
Triage in shadow and its gate, a doc-truth Model check) wait for DNA's
measures: they open only when `recurringClasses` on DNA's Works ask for them.
