---
id: RES-0010
type: research
status: concluded
summary: Compare existing DSH plugins and durable-work tools against System's SC reliability failures, identifying precise reuse boundaries and avoiding a second control plane.
related: [RES-0003, ADR-0001, ADR-0004]
---

# Reliability reuse audit (SC, 2026-11-10)

**Evidence snapshot:** System `dev` at `08b50e8`, external upstream docs
read 2026-11-10. This is comparative research, **not** a shipped capability,
dependency approval, benchmark, or requirement. Verify versions, licensing,
interfaces and costs in a bounded spike before adopting any external component.

## Problem and decision filter

SC reported false terminal failures after quota exhaustion, Host restarts,
flaky checks and publish conflicts. The selected next milestone is safe,
bounded recovery **before** unattended orchestration or more Runtimes.
System owns Task/Work/Attempt, pinned Workflow, Artifact ID, verifier verdict,
command receipts, effects intent/outcome and human approval. Reuse is valid
only if it preserves those contracts and replaces a measured manual action;
a new job queue or model loop is not justified by this evidence.

## Existing System seams, before adding dependencies

- [Work Controller](../../packages/work/src/controller.ts):
  `retryAutomatically` handles configured Worker/check reopen; `recover`
  handles interrupted attempts; `RATE_LIMITED` matches only
  `rate.?limit|too many requests|429|usage limit`, not `out of credits`.
  `observeEffect` can terminalize `absent` publish errors. This calls for
  classification and policy changes, **not** a second controller.
- [Record](../../packages/work/src/record.ts): append-only `dispatched`,
  `observed`, `attempt-lost`, `reopened`, `verified`,
  `effect-intended`, `effect-observed`, `terminal`. Record decisions before
  wait/retry; replay must not re-execute an effect.
- [Host](../architecture/host.md): conservative effect reconciliation and
  uncertain slots already exist; interrupted Works currently do **not**
  resume autonomously. Waiting/elapsed time is in-memory and resets on restart.
- [Headroom](../../packages/work/src/headroom.ts): pure Account ranking
  already exists, so quota readers and error normalization belong at the
  Runtime boundary; keep scheduling decisions in System.
- [Feature Workflow](../../workflows/feature.yaml): bounded `retry.onFail`,
  frozen tests, no-change rerun, checks and publish already compose as steps.

## External components and fit

| Component (primary source) | Verified capability | Decision for SC |
|---|---|---|
| [DSH `dsh-llm-retry`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-retry/README.md) | Classified provider failures, finite backoff, `Retry-After`, durable schedule/start events at agent-step boundaries. Also offers **unbounded** `always` mode. | **Reuse only inside its existing DSH agent-loop path**, when applicable. Borrow typed failure codes and schedule-before-wait semantics; do not wrap System Works with it or enable `always` for unattended jobs. Claude/Codex CLI quota failure is not a DSH LLM request. |
| [DSH LLM contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/README.md) | Structured `RATE_LIMIT`, `QUOTA`, `ACCOUNT_QUOTA`, `AUTH`, `TIMEOUT`, `TRANSPORT`; route by code, not message. | **Adapt at Runtime Adapter boundary** into a System-owned small failure vocabulary. Do not assume external CLIs emit these codes. |
| [DSH session persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence/README.md) | Single-writer append-only log, flush barrier, crash repair and uncertain-tool-effect semantics. | **Learn, not replace.** System Work record is already canonical; DSH session persistence concerns agent conversation history. |
| [DSH `dsh-jobs-local`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/jobs/jobs-local/README.md) | Owner-scoped jobs, cancellation, output and lifecycle events, but **live jobs die with the process**. | **Reject for SC-8 durable recovery**; do not confuse a persisted job event with a resumed job. |
| [DSH ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md) and [community ACP adapter](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter) | Standardized agent/session transport; community adapter documents Claude/Codex profiles (not verified in this System). | **Defer to Worker interchange**; useful for future replaceability, not a replacement for Work retry, checks, quota routing or effect reconciliation. |
| [Temporal](https://docs.temporal.io/workflow-execution) | Durable workflow replay, activities and recovery. | **Reference architecture only.** Migrating System's Host and persisted Work semantics would duplicate/rewrite a working control plane. |
| [BullMQ stalled jobs](https://docs.bullmq.io/guide/jobs/stalled) | Detect and retry stalled jobs via queue worker lifecycle. | **Reference tests only.** New queue/backend and stall semantics add operational cost, and do not solve uncertain external effects by themselves. |
| [GitHub Merge Queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) | Rechecks merged groups against the latest base when repository/CI protection supports it. | **Not a drop-in replacement.** Availability is limited by GitHub repository ownership/plan and requires `merge_group` CI; System already uses leased-push merge queue. Revisit only if repo eligibility and CI integration warrant it. |

Do not install third-party `retry any failure` plugins that lack a bounded
policy and effect-identity guarantees. DSH retry records are instructive, but
their Session step is **not** a System Work/Attempt or publish effect.

## Adaptation rule: reuse the knowledge, not the machinery

For any external example, record **upstream invariant -> existing System seam
-> smallest missing delta -> failure test -> measured outcome -> deletion**.
Prefer a small, dependency-free rule or pure function over loading or copying
an entire plugin. Before porting implementation code, check upstream license,
version, maintenance and test coverage; preserve attribution when applicable.
Do not duplicate a behavior already owned by DSH or System.

Concrete patterns to adapt, rather than wholesale integrations:
- From [DSH retry events](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-retry/src/types.ts):
  durable schedule-before-wait and start-before-execution. Map onto System's
  existing Work record; do not persist a competing Session retry log.
- From [Temporal Workflow Execution](https://docs.temporal.io/workflow-execution):
  replay recorded decisions without repeating effects. Maintain System's
  pinned Workflow and pure record fold; do not import Temporal workers.
- From [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs):
  retries require effect idempotency or reconciliation. Extend existing
  `effect-intended`/`effect-observed` and operationId tests, not a queue.

**Review gate:** reject an adaptation without a demonstrated existing failure,
a red test reproducing it, a bounded/pinned recovery policy, deterministic
replay and side-effect safety, and evidence that the change reduces manual
intervention. Count new core branches and removed/manual mechanisms alongside
LOC. A source example is not permission to copy its API or runtime structure.

## Feedback loop: visible failure, evidence, policy, outcome

**Observed gap in System `dev` (2026-11-10):** events already preserve
`observed`, `verified`, `attempt-lost` and `terminal` failures, and
`retryAutomatically()` reopens selected Workflow steps. But there is no
single failure-origin classification, durable follow-up obligation or
uniform *diagnosis -> decision -> recovery result* across Worker, checks,
Host and publish. Do not describe the product as having no retries: it has
some; the missing contract is *closed-loop recovery*.

**Authority mismatch worth an explicit defect/test:** in
[Host operations](../../packages/host/src/operations.ts),
`work.retry` has `agent: true`. In
[controller](../../packages/work/src/controller.ts), `reopen()` restricts
only verify-step retry to the human caller; Worker-step retry remains
agent-callable. This contradicts the 2026-11-10 operator direction (Q5):
only a human may initiate **manual Work retry**. Change the Host operation
authority and enforce the same rule server-side, with a real Host/MCP
negative test. Keep `work.run` for safe continuation distinct from
`work.retry`, and preserve automatic `reopened: automatic` under a
pinned bounded Workflow policy; do not accidentally disable that path.
Likewise inspect `work.submit force` and fresh-Work submissions for
policy bypass: prohibiting the method name alone is insufficient.

### Smallest contract (proposed, not implemented)

1. **Detect:** surface `failed`, `held`, exhausted retry budget,
   unexpected no-progress/stall, unreadable quota and unknown effect as
   *actionable* Work conditions; do not page on every transient attempt.
   Periodic reconciliation must find outstanding conditions after Host
   restart. Never label a stalled *running* attempt failed on silence alone.
2. **Observe:** preserve error code, provider/account, step, attempt,
   exact Artifact/verdict/effect identifiers, relevant logs, last progress,
   current base/head, timestamps and prior recovery attempts. Avoid
   copying full transcripts or leaking credentials.
3. **Classify:** pure deterministic classification of known error signatures
   into origin (change/outside/unknown), cause (quota, transport, lost
   process, unstable check, conflict, bad input, unknown) and evidence
   confidence. **Unknown is the default** when evidence cannot establish
   cause; heuristic guesses never authorize a risky retry.
4. **Decide:** resolve pinned policy to `continue`, `wait`,
   `retry-step`, `repair-through-workflow`, `hold` or
   `terminal-failure`. Record decision, reason, evidence, budget,
   next eligible time and safety preconditions *before* scheduling.
   Never escalate Worker privileges or mutate the admitted Workflow.
5. **Act:** retry the smallest idempotent step using current retained
   inputs; no retry of successful steps. For effect-intended/unknown,
   reconcile external state first, never blindly publish again. A
   repeated identical failure with unchanged conditions must stop
   looping and transition to a visible hold/terminal outcome.
6. **Verify and learn:** retain both previous and subsequent outcomes,
   classify `recovered`, `still-waiting`, `held` or `failed`;
   count false terminalizations, time-to-diagnosis/recovery and operator
   interventions. Repeated patterns become candidate Items with a
   reproducing regression test (human/operator-approved), **not**
   automatic authority to self-modify policy.

No new model-based "Failure Manager" in core. A separate optional
diagnostic Research Work may inspect existing evidence and propose a cause
or an Item; its output is **advisory** and cannot trigger a new retry,
change a check or approve an effect. Keep one controller and append-only
record. If new durable recovery events are truly needed, add the fewest
events to `record.ts` and test fold/replay and legacy records rather than
a second incident database. The first implementation can be a pure
`diagnoseFailure(record)` projection and existing events wherever
sufficient; persist additional decisions only where timing/replay needs
them.

| Observed signal | Safe feedback | Never do automatically |
|---|---|---|
| Account out of credits | Refresh quota, route to other capable Account or wait | Consume code retry budget or keep retrying exhausted Account |
| Host restarted mid-Worker | Confirm prior process gone, resume pending step | Run two competing attempts or replay unknown effect |
| Flaky check / base also fails | Bounded repeat, compare evidence, hold if inconclusive | Select lucky green check, bypass verification |
| Publish conflict | Produce a repaired change in Workflow, verify against new base | Reuse stale verdict or blind re-publish |
| Faulty test / code | Return exact failed verdict to eligible Worker stage within budget | Call failure outside without corroboration |
| Unknown external effect | Reconcile then hold for human if still unknown | Assume absent or immediately retry |
| No activity beyond threshold | Emit stall/diagnostic signal, inspect liveness | Treat quietness alone as a failed attempt |

### Research informing the design

- [DSH agent/request-error](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md):
  a handler returns a structured retry action or delegates the failure
  instead of retrying every error. This is at *agent model-step*, not System Work.
- [Temporal tasks vs Workflow failure](https://docs.temporal.io/tasks)
  and [retry policies](https://docs.temporal.io/encyclopedia/retry-policies):
  separate infrastructure/task failures from an outcome failure; retry
  the smallest failed activity under policy.
- [Inngest error handlers](https://www.inngest.com/docs/durable-execution/guides-and-advanced/error-handling):
  distinguish a failed attempt, exhausted step and failed run; propagate
  non-retryable failures and handle exhaustion explicitly.
- [Google SRE monitoring](https://sre.google/sre-book/monitoring-distributed-systems/):
  separate symptoms from causes and make human alerts actionable, not noisy.
- [Temporal resumable activity](https://docs.temporal.io/design-patterns/resumable-activity):
  bounded automatic retries can hand off to human correction without
  restarting prior completed work; System should retain its own authority gate.

### Acceptance tests and metrics

- Fault-inject each class above, including Host restart **between recovery
  decision append and retry dispatch**; replay makes at most the authorized
  decision and executes no duplicate external effect.
- Every terminal/held Work exposes **why**, evidence, whether an action was
  attempted, what's next and who can do it (CLI/MCP status).
- Every known eligible transient failure either resumes, waits with a
  recorded reason, or explicitly exhausts its pinned budget. No infinite
  spin; no false automatic conclusion for an unknown cause.
- No Agent/MCP path invokes **manual** Work retry or approval, while
  safe policy-driven auto-reopen remains functional.
- Track rates: `silent_unresolved`, `misclassified_outside`,
  `incorrect_terminal`, `retry_recovered`, `retry_exhausted`,
  `time_to_recover`, and human diagnoses per 10 Items. Validate with
  System's real Work records, not generated examples alone.

## Recommended next step: bounded reliability, no new dependency

1. **SC-8:** On Host start, reconstruct eligible running Works from durable
   state, settle lost-process ownership first, resume only safe steps; unknown
   external effect stays held. Fault-inject crashes at dispatch, observation,
   effect intent and effect application.
2. **SC-14:** Normalize `quota_exhausted`, `rate_limited`,
   `auth_required`, `transient_transport`, `unknown` at each Runtime.
   Refresh the affected Account and route/wait without charging a **code**
   retry. No blind retry on an unreadable quota.
3. **SC-9 / SC-13:** Bounded verification reruns with original and rerun
   verdicts preserved. Distinguish a failing Artifact from inconclusive
   environment; no silent acceptance of an unverified change.
4. **SC-7:** Publish-conflict recovery uses the existing Workflow and rechecks
   the exact new change against current base. Never replay an unknown effect.
5. Measure **Work outcome** separately from **failure origin**
   (change/outside/unknown) and **recovery disposition**
   (resumed/waiting/held/terminal). Track wrong terminalization,
   duplicate effects, outside-incident recovery time, human interventions,
   first-Work acceptance and core growth.

Acceptance gate: zero *incorrectly terminalized* outside failures and zero
duplicate effects in the declared fault-injection matrix; every automatic
recovery is bounded and evidence-backed. Real-provider outages can still
leave Works waiting or held. Operator-only approval/manual retry remains
unchanged; policy-driven retry must be pinned at Work admission. Add no new
orchestration runtime until measurements show a missing contract.

## Limits of evidence

System counts and incidents here come from the operator's 2026-11-10 report,
not an independently audited export of the Work event store. External
documentation proves exposed contracts, not plugin compatibility with this
particular install. All reuse decisions require compatibility tests.
