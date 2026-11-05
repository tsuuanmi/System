---
id: RES-0002
type: research
status: active
summary: Evaluate candidate MVP capabilities against reliability, autonomy, metering and workflow-agnostic evidence without selecting System's architecture.
related: [RES-0001]
---

# MVP selection assessment

**Status: audit hypotheses, not product scope.** Evaluate the fresh System MVP
using [the recorded reference evidence](RES-0001-audit-baseline.md).
Architecture remains draft; the product proposal is [[PROP-0001]].

## Selection rule

A capability enters MVP only if it is needed to demonstrate an agreed outcome,
a safety boundary, recovery, or the ability to perform both a code and non-code
workflow. Choose the **smallest executable slice** with measurable acceptance
criteria. If a capability only improves convenience, defer it. Delete only
after dependency, data-retention, and behavior tests establish safe removal.

## Preliminary capability disposition

| Capability / concern | Hypothesis | Proof required |
|---|---|---|
| Durable task/artifact identity and persistence | **Keep** | crash/restart state test and readable handoff |
| One Worker interface plus one real adapter | **Keep** | capability admission, cancel, timeout, repeatable execution |
| Idempotency / effect journal / reconciliation | **Keep** | kill at effect boundaries; no duplicate external actions |
| Minimal policy, tool approvals, data-egress gate | **Keep** | denied action cannot escape via another path |
| Usage accounting and a baseline metrics view | **Keep** | provider oracle, delta accounting across resumed sessions |
| Independent review plus exact-result required checks | **Test for MVP** | measurable quality gain for cost; minimal subject binding |
| One non-code workflow using the same engine | **Keep as acceptance test** | completes without changing controller implementation |
| Git/PR landing workflow and batch operator approval | **Evaluate** | if release target is code delivery, test the merge boundary |
| DSH/Cordis host and each plugin | **Benchmark / inspect** | dependency closure, cold start, CPU/RAM, correctness and maintenance cost |
| Website browser Workers | **Defer by default** | demonstrated indispensable MVP use case and reliability |
| Model-provider gateways, expanded UI/reporting | **Defer by default** | users cannot achieve basic workflow via simpler interface |
| Auto-start per project | **Evaluate behind explicit policy** | material reduction in operator touches without safety regression |
| Scientific research profiles, experiment registry and feedback platform | **Defer platform breadth** | keep only a tiny non-code end-to-end test first |

*Keep* means an audit priority, **not** a commitment to import existing code.

## Audit workstreams and outputs

1. **Inventory:** enumerate plugins/packages and their configured-on status.
   Output: verified package graph, owners and execution entry points.
2. **Reachability:** map a minimal local client → task → Worker → artifact →
   verification → decision path. Output: indispensable dependency closure.
3. **Effect integrity:** trace persistence, lease fencing, retries, cancellation,
   approvals and egress. Output: crash and abuse-case test matrix.
4. **Metering and latency:** inspect usage sources, resumed sessions,
   approvals, worker startup and time allocation. Output: reproducible baseline.
5. **Removal experiment:** switch off candidate capabilities in a disposable
   test profile. Output: what breaks, what tests prove no regression.
6. **Decision:** compare a minimal DSH/Cordis composition with alternatives on
   identical acceptance tests. Output: an operator-reviewed proposal and ADRs,
   not an implicit architectural choice.

## Proposed MVP proof matrix

| Test | Expected proof |
|---|---|
| T1 Start/finish | one task runs through client, policy, Worker and result |
| T2 Crash/restart | killed process resumes or reconciles without duplicated effects |
| T3 Trust boundaries | denied tool, secret or forbidden egress is blocked |
| T4 Accounting | usage delta is correct when a Worker session is resumed |
| T5 Outcome quality | independent check acts on exact immutable result |
| T6 Workflow portability | at least one non-code task runs through same controller without code changes |
| T7 Operator autonomy | accepted tasks and approval requests are instrumented |
| T8 Runtime cost | measure cold start, steady RAM/CPU, latency and maintenance surface |

These are **test proposals**, not passing results or established thresholds.

## Audit acceptance

Deliver a scored keep / replace / drop / defer table with evidence links,
dependency closure, test coverage, measured cost, and unresolved risk. Compare
the minimal tested architecture against [[PROP-0001]] and ask for acceptance
before freezing System's MVP requirements.

No additional board, roadmap, PLAN.md or STATUS.md is maintained in the source
tree to duplicate decisions.
