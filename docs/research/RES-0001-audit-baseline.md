---
id: RES-0001
type: research
status: active
summary: Establish a pinned external implementation baseline and classify evidence for a reliability-first MVP audit.
---

# Audit baseline from a reference harness

**Recorded 2026-11-05. Non-normative.** The audit target is an **external
reference implementation** ([source repository](https://github.com/tsuuanmi/system_1)),
not the origin, specification, or identity of fresh System. Do not import its
package structure, old decisions or release numbering as local authority.

## Pinned evidence

- [Reference governance decision, ADR-0086 at 053c9967](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/docs/decisions/adr/0086-production-is-the-lean-core-judged-by-reliability-targets.md): accepted **in that repository** on 2026-11-05.
- [Release scope at same commit](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/docs/requirements/release-scope.md): defines R1–R5 for that installation.
- [Proposed lean-core simplification](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/docs/proposals/0022-lean-core.md): earlier hypotheses and deployment measurements.
- [Measured research, 2026-11-01](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/docs/research/lean-core-2026-11-01.md): measurements from its local live store and runs; **not reproduced** in this audit.
- [Generated package map at same commit](https://github.com/tsuuanmi/system_1/blob/053c99678c30faad0aa8fab6ae8e850052c7ce6a/docs/architecture/packages.md): declared plugin packages, seams, consumers and code dependencies; not a runtime proof.

The reference repository's `docs/production-direction` branch was inspected
at `053c99678c30faad0aa8fab6ae8e850052c7ce6a`. It is **not**
necessarily its main branch, current production deployment, or merged state.

## Observations reported by the reference

| Dimension | Reported observation | Audit interpretation |
|---|---|---|
| Task completion | median 1.6 h for created-to-done tasks | Too slow for a tight feedback loop; verify definition and samples |
| Unattended completion | 6.5% | Operator attention is a dominant bottleneck |
| Operator decisions | ~116/day | Approval policy and task boundaries deserve inspection |
| Metered spend | ~3.9× overcount when sessions resume | Test usage deltas and provenance before trusting cost |
| Website Worker usage | ~3% of work | Web automation may be optional in the initial slice |
| Approval deferrals | ~25% of agent runs ended on an approval wait | Test bounded waiting and policy-class ordering |
| Low-use features | gateways, scheduled review, experimental feedback mechanisms | Demand observed utility before putting them into MVP |

These figures are historical **claims from a separate installation**, not
fresh System measurements or verified present-day metrics.

## Reference exit targets (not yet System commitments)

The reference's accepted ADR-0086 uses a 14-day live window:

| Target | Reference release criterion |
|---|---|
| R1 | >=99% of in-flight runs at restart reach terminal state without manual repair; zero duplicate effects |
| R2 | >=50% accepted tasks have no operator touch between charter and merge batch |
| R3 | usage ledger within 10% of providers' own records |
| R4 | <=10 operator decisions/day |
| R5 | >=3 accepted live research/non-code workflows without engine changes |

These are **candidate audit acceptance criteria**. Applicability to the new
MVP requires a separately accepted requirements decision and measurable event
definitions.

## Evidence gaps

- The reference dataset and live install were not accessed in this PR.
- Reported metrics may be sampling-specific or affected by known ledger error.
- A generated package map shows intended dependencies but cannot prove which
  plugins are mounted, exercised or required for the minimal workflow.
- Source-level code paths, tests, crash behavior, egress and credential boundaries
  need an independent audit before design choices are adopted.

Use [[RES-0002]] for the **assessment**; keep raw evidence and its limitations here.
