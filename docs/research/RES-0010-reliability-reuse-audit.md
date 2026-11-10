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
