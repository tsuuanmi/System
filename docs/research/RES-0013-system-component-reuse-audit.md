---
id: RES-0013
type: research
status: active
summary: Source-grounded reuse-first audit of System components, mapping existing ownership, upstream alternatives, integration seams, risks and the minimal changes worth testing.
related: [ADR-0001, ADR-0002, ADR-0003, ADR-0007, ADR-0009, PROP-0008, RES-0012]
---

# System component audit: reuse first, adapt only at the boundary

**Snapshot:** \`dev\` at \`b789061\`, inspected 2026-11-14 through GitHub
source and package documentation. This is a **static review** plus upstream
primary-source comparison, not an executed test suite, a completed subagent
audit, a production penetration test or an accepted architecture decision.
The product proposal is [PROP-0008](../proposals/PROP-0008-system-across-projects-workers-and-time.md).

## Non-negotiable decision rule

> **Reuse -> configure -> adapt -> integrate -> build only when a measured
> contract gap remains.** Existing ownership is a reason to improve the
> integration, not duplicate the component.

For every proposed capability, require the proposing Worker to produce:

1. **Required outcome:** concrete user problem, acceptance and failure cases.
2. **Inventory:** System source owner, DSH/Cordis service, existing PR/branch,
   applicable upstream/library/protocol, owner and maintenance status.
3. **Gap:** what is missing at the *contract* boundary, proven with source,
   test or reproduction; distinguish missing feature from discoverability.
4. **Options:** (A) enable/configure existing, (B) adapt wrapper/official SDK,
   (C) improve existing component, (D) build minimal new logic. Compare
   capability, API stability, privileges, restart behavior, cost, complexity
   and ongoing maintenance; document rejection of A-C before D.
5. **Integration:** keep the **existing** Work/Attempt/Artifact/Verdict/Effect
   authority; identify one owner per state and external side-effect.
6. **Conformance:** fake/real integration, negative authorization tests,
   recovery/fault-injection, performance and rollback before default enable.
7. **Net change:** report added/deleted core LOC and dependencies. Prefer a
   smaller adapter or removal of duplication; do not create a package merely
   to wrap a one-line operation.

**PR rejection criteria:** duplicate scheduler, Artifact database, retry
engine, merge queue, process supervisor, CLI agent loop, Goal state machine,
or vendor-specific Work status when System already has its equivalent. An
exception needs measured evidence and a documented migration/removal plan.

## Component inventory: real code owner and reuse decision

| Existing capability and source | Current owner / relevant external solution | Audit decision / smallest delta |
|---|---|---|
| Plugin composition, config, storage, credentials and subprocess | [bundle](../../packages/bundle/README.md), [Cordis patch](../../packages/bundle/cordis.patch.yml); upstream [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) | **REUSE:** DSH/Cordis already supplies storage-domain/SQLite WAL, attachments, credentials and subprocess. Do not reproduce as System libraries. Add/replace optional Cordis rows at documented seams. |
| Work, Attempt, durable events, Host lock, restart recovery, command receipts | [work](../../packages/work/README.md), [host.ts](../../packages/work/src/host.ts) | **KEEP:** one Work authority. Refine eligibility/dispatch above it, never add another Work scheduler or replay store. |
| Workflow compilation, retry and independent steps | [workflow.ts](../../packages/work/src/workflow.ts), [develop.yaml](../../workflows/develop.yaml), [brainstorm.yaml](../../workflows/brainstorm.yaml) | **REUSE/ADAPT:** express coordination as Workflows + small Items; use existing bounded retry, conditional steps and sub-workflows; no general agent-loop engine. |
| Item/status intake and claims | [status.ts](../../packages/work/src/status.ts), [STATUS.md](../../STATUS.md), [operations.ts](../../packages/host/src/operations.ts) | **EXTEND IN PLACE:** repository markdown + derived status from Work events. Add dependency/readiness interpretation only if needed; no new Goal DB by default. |
| Worker dispatch, capability, account slots, quotas | [registry.ts](../../packages/work/src/registry.ts), [slots.ts](../../packages/work/src/slots.ts), [agents README](../../packages/agents/README.md) | **EXTEND:** project-level fairness and measurable cross-project allocation are candidate gaps, not a reason to replace routing. Test 1/4/8/20 capacity before changing scheduling. |
| CLI Worker launch, model selection, workspace | [agents](../../packages/agents/README.md), [runtimes.ts](../../packages/agents/src/runtimes.ts), [workspace.ts](../../packages/agents/src/workspace.ts) | **KEEP/ADAPT:** existing Claude/Codex invocations, isolated git worktrees, Task materialization and runtime usage. Add a provider adapter at WorkerPort; do not rewrite CLI, git workspace management or quota readers. |
| Provider-neutral ACP Worker | [draft PR #72](https://github.com/tsuuanmi/System/pull/72), [stacked draft PR #73](https://github.com/tsuuanmi/System/pull/73), official [ACP v1](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx); [DSH ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md) | **FINISH/VERIFY EXISTING WORK:** PR #73 already explores the official TypeScript SDK and optional Cordis adapter. Do not launch a second ACP bridge or new Rust protocol runtime. ACP is a transport, not verified Work authority. DSH ACP server differs from its parent-agent ACP client; prove the selected path on real providers. |
| Remote terminal / subagent lifecycle | [Herdr TUI](https://github.com/herdrdev/herdr), [Herdr Core](https://github.com/herdrdev/herdr-core), [agent automation](https://herdr.dev/tui/docs/agent-automation/) | **EVALUATE ADAPTER, NOT REBUILD:** use Herdr Core's headless run/send/read/wait, child lifecycle, machine/SSH and API only if simpler than direct WorkerPort/ACP extension. Herdr TUI and Herdr App/Core are separate systems; their agents are not one shared pool. Terminal status is not a System verdict. |
| Artifacts and immutable provenance | [artifacts](../../packages/artifacts/README.md), DSH attachment store | **KEEP:** exact bytes, content IDs and typed evidence; no parallel file ledger or second blob store. Add minimal search/index only after query demand. |
| Independent verification | [verifiers](../../packages/verifiers/README.md), [checks.yaml](../../.system/checks.yaml) | **KEEP:** pinned criteria, independent code checks, pass/fail/inconclusive. Reuse CI commands; no model-synthesized "passed" evidence, never let a worker weaken pinned checks. |
| Git PR, merge and external effect reconciliation | [effects](../../packages/effects/README.md) | **KEEP:** stable operation ID, lease-based publish, merge-tree + exact-tip checks and reconcile. External tracker adapter must not bypass effect ownership or initiate a second merge queue. |
| Claude/Codex caller experience | [app](../../packages/app/README.md), [mcp.ts](../../packages/app/src/mcp.ts), Host JSON-RPC | **KEEP:** caller can work from any project, submit Work and observe results. Extend command discoverability, not model-specific control plane or new mandatory UI. |
| New-project docs and CI bootstrap | [portable bootstrap](../governance/bootstrap.md), [bootstrap_docs.py](../../tools/bootstrap_docs.py), [docs.py](../../tools/docs.py) | **INTEGRATE:** a \`system bootstrap\` plan/apply/check can orchestrate existing scaffold, repo CI inspection, target-local checks and explicit approvals. Do not copy System-specific requirements to other projects. |
| Scheduled background sessions and notifications | [bundle](../../packages/bundle/README.md), [night launcher](../../packages/bundle/system-night-session.sh) | **REUSE:** systemd service/timer and session report Artifact path already exist. Evaluate a small ready-Item dispatcher using Host claims/receipts; no Cron/Temporal replacement or extra all-day LLM process. |
| Web Worker / UI automation | [web-worker](../../packages/web-worker/README.md), [web-driver](../../packages/web-driver/README.md) | **MAINTAIN OPTIONAL:** existing off-by-default web Runtime and map-driven driver. Avoid rebuilding browser automation; test whether generic upstream browser/driver APIs can replace narrow custom logic before adding maintenance. |
| Test doubles and integration checks | [fakes](../../packages/fakes/README.md), [tests](../../tests/README.md), [checks.yaml](../../.system/checks.yaml) | **REUSE:** add fault-injection and conformance cases to existing suites, not an alternate test runner or invented test outcomes. |

## Evidence-backed gaps, with action boundaries

### A. P0 investigation — authority is asserted by client, not proven by Host

- [Host index.ts L193-L218](../../packages/host/src/index.ts) validates
  the *shape* of a supplied \`host.hello.caller\`, stores its \`type\`, then
  authorizes operations from \`type\`. [CLI io.ts](../../packages/app/src/io.ts)
  uses \`SYSTEM_CALLER\` or terminal detection to choose its label.
  [Host operations.ts](../../packages/host/src/operations.ts) marks
  \`approval.decide\` human-only but \`work.retry\` and \`force\`-bearing
  \`work.submit\` as callable by agents. Host socket reachability and the
  client-chosen role form a **potential trust-boundary gap**; exploitation
  has not been attempted in this audit.
- **Minimal fix to investigate:** authenticate/attest privileged operations
  at Host boundary using OS peer/process identity or a separately held
  operator capability. Do not invent a new identity provider if Unix
  permissions and an existing credential boundary suffice. Define
  explicit semantics for agent retries and \`force\`, then negative test
  direct socket and MCP callers. This overlaps an earlier concern noted
  in [draft PR #181](https://github.com/tsuuanmi/System/pull/181);
  **reuse/reconcile that work**, do not create a competing security rewrite.

### B. P1 — decomposition and unattended dispatch are glue, not Goal machinery

- [status.ts](../../packages/work/src/status.ts) already parses
  \`STATUS.md\`, reads \`origin/dev\`/dev, identifies active Work and
  derives done from merge evidence. [Host](../../packages/work/src/host.ts)
  already has Item claim and command-idempotent submit.
- No demonstrated need for a new Goal DB or planner agent. First test a
  deterministic, idempotent loop \`scan ready Items -> acquire claim ->
  submit bounded Work -> read verdict -> expose next ready Item\`.
  If dependencies in markdown cannot be queried safely, reuse an issue
  tracker or add a small **derived** index; keep the source of truth clear.
  A ready Item needs bounded scope, dependency/input IDs, exact acceptance,
  output expectations and an escalation policy.
- Start with a **human/Claude/Codex-authored Item decomposition**; compare
  quality of decomposition before developing another planner capability.
  Experiment with System's existing research/brainstorm Workflows as
  independent critique, not a mandatory extra planning layer.

### C. P1 — agent supervision across remote machines is not yet Work recovery

- Herdr Core manages live remote terminal/process state, child agent
  notifications and reconnect; [its README](https://github.com/herdrdev/herdr-core)
  explains that a lost kept program's shell can be restored without
  rerunning the job. A terminal state of \`done\` cannot prove a Work is
  verified; loss of SSH is **unknown**, not evidence of failure/success.
- An adapter must map a remote Attempt ID to machine + terminal identity,
  capture exact outputs, cancel safely, reconcile unknown-running attempts,
  and avoid spawning duplicates after Host/client restart. Check account
  credentials, machine allowlists and OS-level isolation. Bench against
  existing local WorkerPort before adopting Herdr as a dependency.
- If ACP draft PR #73 covers the selected provider, finish it first; a
  Herdr process transport may be an *optional execution layer*, not a
  competing provider protocol.

### D. P1 — isolation and policy enforcement precede unattended scale

- [agents runtimes.ts](../../packages/agents/src/runtimes.ts) filters
  environment and uses CLI tool permission flags; that is **not equivalent**
  to an OS/VM sandbox with controlled filesystem and network egress.
  Examine existing DSH/runtime sandbox facilities before implementing
  security primitives. Audit process ownership of workspace, remote
  agent, subprocess and external credentials.
- \`system mcp\` already lets agent sessions act as callers. New automatic
  dispatch and bootstrap must **not** infer operator authority from
  prompt words or a client-set role. Prevent notification/retry storms
  and resource starvation across projects.

### E. P2 — discoverability and report delivery, not new orchestration

- [MCP instructions](../../packages/app/src/mcp.ts) say new repository
  bootstrap has "no script" even though the repo has
  [bootstrap_docs.py](../../tools/bootstrap_docs.py). Fix the instructions
  alongside a tested \`system bootstrap\` integration.
- Existing scheduled session and Artifact report path can serve
  attention-aware reporting. First audit delivered/failed/missed
  notification outcomes and ensure failures are visible before adding a
  different notification service.
- Existing [research PR #181](https://github.com/tsuuanmi/System/pull/181)
  already examines DSH retry/error/ACP, Temporal and BullMQ; reconcile it
  rather than produce another autonomous feedback scheduler.

## Executable audit protocol (not run in this review)

Parallel **read-only** audits can use existing Claude/Codex caller sessions
and ordinary System Work/WorkerPort; there is no need for an agent-team
framework. Partition by (1) Work/Item/controller, (2) Host/security/MCP,
(3) Worker/ACP/Herdr/remote, (4) verifier/Artifact/effects, (5)
bootstrap/operations/reporting. Each returns a structured Artifact with
source:line, reproducible evidence, effect on user outcome, existing
alternative, **reuse/adapt/build verdict**, minimal delta, confidence and
regression check. A separate review Work synthesizes, an independent check
validates contested claims, and only **accepted** findings become Items.

**Safety gates:** separate read-only workspaces and credentials, no push,
approval, forced Work, production credentials or modifications to live
repositories. Prompt "read-only" is not an OS permission boundary: enforce
capabilities/permissions and confirm subagents cannot write before spawning.
On a remote worker, failures must be reconciled before any retry. This
research file documents the static audit and proposed team execution, **not
actual multi-agent execution**.

## Recommended low-regret order

1. **R0:** source/test-backed Host authorization test and minimally scoped
   hardening; reconcile PR #181's existing findings.
2. **R1:** zero-new-DB Item decomposition/readiness experiment, plus fix MCP
   bootstrap discovery; measure verified outcomes after caller restart.
3. **R2:** complete/rebase existing ACP PR #72/#73 contracts and conformance;
   no second protocol implementation.
4. **R3:** optional one-machine/one-remote Herdr Core adapter benchmark with
   unknown-state recovery and no duplicate effect.
5. **R4:** tune quota fairness, context/reporting and multi-project throughput
   using existing Work metrics; keep single-Worker baseline.

**Deliberately deferred:** new Goal state store, planning-brain service,
all-in-one agent framework, remote scheduler, new artifact DB, a fresh
browser engine, and automatic unapproved self-upgrade.
