---
id: ADR-0006
type: decision
status: accepted
date: 2026-11-06
summary: Bring into MVP-0 the Workflow fields the two domain proofs needed (inputs, version, instructions, effect, approval), which ADR-0004 had deferred, and record the rules that bound them.
related: [ADR-0002, ADR-0003, ADR-0004]
---

# The MVP-0 Workflow vocabulary

## Context

[ADR-0004](ADR-0004-mvp-0-operating-decisions.md) deferred to MVP-1 any
"Workflow schema beyond `steps`, `dependsOn`, `capabilities`, `outputs`,
`verify` and `accept`". Building MVP-0 showed that the two required domain
proofs cannot be expressed with that list alone, and the implementation added
fields before this was recorded. An independent review flagged the drift.
This ADR records the decision instead of leaving the accepted ADR silently
contradicted.

## Decision

`system.workflow/v1` (see [workflow composition](../architecture/workflow-composition.md))
is the MVP-0 vocabulary, with these additions to ADR-0004's list:

1. **`version`** (required) on the file: a pinned spec names what it was
   admitted from.
2. **`inputs`** on a Worker step (`$work.input` or `$steps.<step>.<slot>`):
   MVP-09 requires explicit Artifact-ID bindings; without them a step cannot
   name what it consumes.
3. **`instructions`** on a Worker step: the step's own instructions, such as
   the Research `sources` format the citation verifier checks. Data, not code.
4. **`effect`** step (`capability`, `subject`, `requires`, `params`):
   ADR-0004 decision 10 makes push and the draft pull request System effects,
   and decision 12 orders them after a pass; a step form lets the one
   controller sequence and record them without a domain branch.
5. **`approval: operator`** on `accept` (replacing the sketch's
   `operator-merge`, since System never merges).

Model tiers are not schema: they are capabilities (`tier.<name>`).

## Consequences

- Preflight refuses every field outside this list, as before.
- Loops, conditionals, retries, timeouts and concurrency stay out of MVP-0.
- ADR-0004's deferral now reads "beyond `system.workflow/v1` as of ADR-0006".
