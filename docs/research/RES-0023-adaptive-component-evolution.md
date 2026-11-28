---
id: RES-0023
type: research
status: active
date: 2026-11-27
summary: Adaptive component evolution, build-versus-reuse decisions, and execution contracts.
related: [RES-0022, RES-0015, RES-0016, RES-0017, ADR-0003, ADR-0004, ADR-0012, ADR-0013, ADR-0016, ADR-0018]
---

# Adaptive System: evolution beyond any one runtime

**Research and operator direction (2026-11-27), not an accepted ADR, released feature or backlog.**
This is the follow-up brainstorm to [RES-0022](RES-0022-agent-workspace-landscape.md).
The operator's goal is a **truly adaptive System** that continuously learns from
both its own operation and external projects. Every component may be retained,
improved, replaced with a proven existing implementation, or rebuilt better.
A component is not special because System wrote it, and upstream is not better
merely because it has more features or a larger community.

**Thesis: System owns the truth of work, not necessarily the machinery performing it.**
Keep Work orchestration, Governance, Verification and operator authority as
System responsibilities. Make implementation choices revisable through
versioned contracts and evidence, rather than permanent framework loyalty.
The [Product Charter](../requirements/purpose.md) is still binding:
"Work persists. Workers change. Humans govern."

**Review and implementation map:** [RES-0024](RES-0024-adaptive-system-insights-and-adoption-gates.md)
condenses the eight cross-project insights into evidence gates, adversarial
checks and a local System review handoff. It is not an accepted proposal.

## 1. Separate three kinds of orchestration

| Layer | Authority | Example |
| --- | --- | --- |
| Planning/decision | Operator settles Intents; caller supplies Items | Decide scope, dependencies and acceptance criteria |
| Work orchestration | System owns Work/Attempt/Artifact, retries, policy, effects, verdicts | Admit and verify a pinned Workflow |
| Worker-local execution | Approved runtime owns session/process, tools, subagents | Run Codex, Claude, ACP or a daemon-owned worker |

The [Host never picks Items](../decisions/ADR-0012-host-carries-works-on-never-picks-items.md).
Worker-local subagents can help finish a declared Attempt but may not
create authority, choose new Items, override a verifier or approve a merge.
External `worker_done` and `idle` remain **observations**, not accepted results.

## 2. Architectural options A, B, C and D

| Option | Upside | Downside | Research stance |
| --- | --- | --- | --- |
| A. Native CLI adapters only | Direct control, simple ownership | Continuing CLI upkeep | Preserve as baseline |
| B. Outsource the entire orchestrator | Mature UX, sessions, many agents | Two schedulers and divergent Work truth | Do not default to this |
| C. Hybrid: external execution backend | Reuse process/session infrastructure | Remote recovery and permissions | Test one narrow seam |
| D. Protocol-first (ACP) | Provider-independent sessions | Incomplete/versioned semantics | Evaluate within C |

A, C and D are compatible: keep a native fallback, try one external
backend, and consider a protocol when it reduces repeated adapters.

**Orca** offers experimental structured Runs, Tasks, Dispatches and
coordination, plus headless `orca serve`. A Run is not an automatic
scheduler and Orca's orchestration is not System's immutable verdict gate.
See [Orca orchestration](https://github.com/stablyai/orca/blob/main/docs/site/content/docs/cli/orchestration.mdx)
and [remote server](https://github.com/stablyai/orca/blob/main/docs/site/content/docs/remote-servers.mdx).

**Paseo** has daemon-owned sessions and a supported TypeScript SDK
`@getpaseo/client` with create, agent IDs, reconnect and wait-for-finish.
`create()` returns before the prompt completes; a wait timeout does not
cancel execution. These details make it a useful first integration hypothesis.
See [SDK](https://paseo.sh/docs/sdk),
[agents](https://paseo.sh/docs/sdk/agents) and
[architecture](https://github.com/getpaseo/paseo/blob/main/docs/architecture.md).

**Agent Client Protocol** provides session operations and capability
negotiation, with richer resume/state synchronization documented for v2.
**ACP v2 is a draft as of this study**; do not assume all agents support it.
An ACP conversation session is not a System Work or Attempt identity.
See [ACP](https://agentclientprotocol.com),
[v2 draft](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/announcements/acp-v2-draft.mdx)
and [OpenHands ACP agents](https://github.com/OpenHands/docs/blob/main/openhands/usage/agent-canvas/acp-agents.mdx).

## 3. The adaptive improvement cycle

~~~text
Observe real Work outcomes, failures, costs and operator interventions
  -> Identify the bottleneck and current implementation
  -> Discover keep / improve / reuse / adapt / build alternatives
  -> Define invariants, evaluation cases, budget and rollback in advance
  -> Run isolated, reproducible trials
  -> Compare security, verified outcomes, recovery, cost and maintenance
  -> Propose a decision, with evidence and uncertainty
  -> Operator authorizes any policy/security or promotion change
  -> Canary, observe, roll back if needed; retire after migration
  -> Repeat when evidence or upstream capabilities change
~~~

This is **not** automatic self-rewriting. Agents may research, benchmark,
propose and implement a permitted change as a normal Work. They may not
promote their own new approval rules, change acceptance criteria, or grant
themselves protected-branch access.

A good replacement process must be reversible: otherwise "adaptive" becomes
irreversible dependency churn. Record the winning and losing experiments.

## 4. What is swappable and what remains System's truth

| Potential component | Reuse/build candidates | Contract that must survive |
| --- | --- | --- |
| CLI or session execution | Native, Paseo, Orca, ACP | One Attempt, durable observations |
| Process/workspace supervision | Native watcher, worktree tool, sandbox | No unauthorized write/effects |
| Provider adapters | Native parsing, SDK, protocol client | Account identity and quota pool |
| Scheduling/routing strategy | Headroom, measured Role x Runtime x Model | Admitted capabilities and ceilings |
| Observability/UI | CLI, read-only dashboard, mobile | UI is not the Work ledger |
| Test/citation/review verifier | Existing runner or validated replacement | Pinned criteria on exact Artifact |
| Persistence/transport | Compatible store or protocol | Event replay and effect reconciliation |
| Credential/isolation backend | Approved sandbox, VM, credential broker | Operator authority unreachable |

These are **candidate boundaries**, not a requirement to create plugins
for every function. Immutable identifiers, historical verdict meaning,
Work admission semantics and human approval must stay governed.
Swapping a storage implementation requires versioned migrations and
replay tests; the Work ledger cannot have two simultaneous authorities.

The priority is an implementation-independent **contract**, not a
maximal abstraction framework.

## 5. Reuse versus build: choose from evidence

| Choice | When it may be right | Required check |
| --- | --- | --- |
| Improve current | Focused bug or minor performance gap | Targeted regression passes |
| Reuse upstream | Stable public API, good fit, less upkeep | License, security, integration tests |
| Adapt/fork | Strong foundation but incompatible boundary | Pinned upstream, divergence budget |
| Build better | No option satisfies mandatory invariants | Measured benefit, realistic maintenance |
| Retire old | New implementation and migrations are proven | Drain, replay, fallback, rollback |

Assess correctness, security, reliability, verified success per operator act,
time to verified result, total cost, maintenance/upgrade hours, portability,
dependency risk and the **ability to replace the component again**.

No fixed percentage is proposed here. Set evaluation thresholds and sample
size before running a trial. Avoid declaring a winner on one successful run,
headline speed, model preference, or a large agent-provider list.

## 6. Possible ExecutionBackend seam (research sketch)

Current System has a [CliAdapter registry](../../packages/runtime-cli/src/adapters/index.ts),
[CLI interface](../../packages/runtime-cli/src/adapters/types.ts) and
[shared Attempt lifecycle](../../packages/runtime-cli/src/lifecycle.ts).
That lifecycle handles timeout, cancellation, workspace, logs and outputs.
Do not blindly force a daemon/ACP runtime through CLI-only APIs like
`defaultCommand` or `askArgv`.

The Host-to-Runtime seam the controller sees is already `WorkerPort`
(`run`, `gone`, `end`; [registry](../../packages/work/src/registry.ts)), and
`runAttempt` already takes any `Turn` ([lifecycle](../../packages/runtime-cli/src/lifecycle.ts)):
the web Runtime is a non-CLI `WorkerPort` built that way, without a `CliAdapter`.
[ADR-0018](../decisions/ADR-0018-runtimes-plug-into-the-worker-registry.md) (accepted
2026-11-28) made it the one registry: a registration also carries `status()`, `quota()`,
`version()` and optional `signIn?`/`recheck?`, and each Runtime plugin owns its Accounts.
A new backend is one more Runtime plugin registering `WorkerPort` rows; the sketch below lists
only what such a row must show, not a new interface to add:

~~~ts
// Illustrative, not an accepted implementation schema.
interface ExecutionBackend {
  start(request: ExecutionRequest): Promise<StartReceipt>
  observe(executionId: string): AsyncIterable<ExecutionEvent>
  reconcile(executionId: string): Promise<ExecutionState>
  stop(executionId: string, reason: string): Promise<StopReceipt>
  collect(executionId: string): Promise<ExecutionOutput>
}
~~~

| Method | Invariant to demonstrate |
| --- | --- |
| `start` | Retry-safe correlation/Attempt ID, no duplicate process |
| `observe` | Ordered evidence and reconnect without false events |
| `reconcile` | Running, finished, blocked, lost and *unknown* stay distinct |
| `stop` | Idempotent, generation-scoped, no stale cancel |
| `collect` | Redacted logs, bounded output, structured result, exact commit/tree |

The API shape alone solves none of the hard problems. Explicitly assign
ownership of credential staging, timeout, sandbox, process exit, log retention,
session cleanup, quota and usage observation **before** implementing it.
Do not duplicate the System Host's Work lifecycle inside the backend.

## 7. Five competing viewpoints

| Perspective | Priority | Failure to avoid |
| --- | --- | --- |
| Product architect | Own durable outcome semantics, not all tools | Rebuilding every IDE capability |
| Reliability engineer | Recovery, idempotency, generation fencing | Blind retry of uncertain launch |
| Security engineer | Enforced scope and credential isolation | Host daemon bypasses sandbox |
| AI engineer | Right Role x Runtime x Model by evidence | Noisy routing on tiny samples |
| Operator | More verified Items per intervention | Extra consoles but same workload |

The hardest question is not how to call Paseo's SDK.
It is whether System can replace that SDK later without changing the
meaning of a Work, an Artifact or an operator decision.

## 8. Adversarial scenarios to evaluate

- **Lost launch receipt:** remote daemon started a worker but its response
  disappeared. Reconcile by stable correlation ID, never blindly spawn twice.
- **Competing retry loops:** Orca/Paseo retries a step while System does too.
  Work-level retries stay with System; worker-local subagents are bounded.
- **Stale completion:** old worker returns after its Attempt was replaced.
  Fence on Attempt ID, generation and exact output Artifact.
- **False green:** backend says `idle`/`worker_done` but outputs are missing
  or pinned checks fail. Record observation; deny verification acceptance.
- **External sandbox bypass:** host-level daemon launches a process outside
  System's sandbox. Constrain the **actual child process**, not only the caller.
- **Duplicate subscription aliases:** direct CLI and daemon use the same
  provider Account; quota must count once, without optimistic round robin.
  Today's refusal of a second ref is keyed by `runtime:providerAccount`
  (packages/runtime-cli/src/index.ts), so a second Runtime on the same account is not caught.
- **Version/schema change:** keep backend, protocol, capabilities, Account and
  verifier version provenance on every Attempt; reject unknown semantics.
- **In-flight migration:** drain/reconcile live sessions, preserve historical
  replay and retain native fallback before removing the prior implementation.

What ADR-0016 enforces today is stated once, in
[RES-0022's security state](RES-0022-agent-workspace-landscape.md).
A new external backend must meet the enforced boundary before writing code.

## 9. Experiment: one Work, three backends

Test on the same Task, repository base, model (where possible), pinned
verification, budgets and independent workspaces:

1. Native System direct CLI (baseline).
2. Paseo daemon/SDK, first external execution hypothesis.
3. Orca headless/CLI, second hypothesis after the first has useful evidence.
4. ACP as a protocol sub-experiment, noting that v2 is draft.

| Test case | Required outcome |
| --- | --- |
| Clean task | One Attempt and accepted exact-subject output |
| Deliberately failing test | Bounded failure evidence and no false acceptance |
| Host restart | Resume or mark uncertain; never duplicate execution |
| Backend disconnect | Report unknown, reconcile before replay |
| Stop/late result | No orphan, stale completion or wrong-generation stop |
| Permission probe | No Operator-socket, protected push or secret access |
| One account via two paths | Correct shared quota and identity |
| Upgrade and rollback | Replay prior records, native fallback still works |

Track verified success rate, time to verified resolution, operator
interventions, Outside failures, escaped defects, usage completeness,
maintenance hours and total cost. No shadow execution against the
same *live writable* branch. Start read-only or on isolated clones;
allow write canaries only after the trust boundary has been proven.

The experiment succeeds only if the backend improves real outcomes
**without weakening Work semantics, authorization or verification**.

## 10. Evolving System without losing governance

A caller Workflow may perform discovery, measurements, comparative reviews,
controlled tests and candidate patch generation. The evidence chain should be:

1. Observation Artifact: real failure, baseline and environment.
2. Candidate Artifact: upstream commit, license, scope, compatibility.
3. Evaluation Artifact: test corpus, results, uncertainty, regressions.
4. Proposal: reuse/keep/build alternatives, costs and rollback.
5. Operator decision for changes to authority or production promotion.
6. Limited, version-pinned canary without reinterpreting older Works.
7. Monitoring, automated detection and **operator-governed** rollback.
8. Retirement only after drain, migration, recovery and replay checks.

Do not assume an adaptive feature engine may choose its own STATUS Items:
the Host never selects work. Do not install unreviewed plugins with access
to credentials or the Host store. Research must not silently become an ADR.

## 11. Wider product horizon and next questions

In a genuinely adaptive System the operator could choose different execution,
verification and UI components (a changed Verifier still needs an Approval:
ADR-0013) for code, scientific investigation, web
research and data workflows, while preserving provenance and accepted
outcomes. This is a *possibility*, not an implemented multi-domain claim.

Recommended research progression: harden present invariants; measure the
largest current bottleneck; isolate one narrow boundary; compare native
against one external implementation; decide with evidence; canary and
rollback; repeat only where it improves verified work.

Questions for an operator decision:

- Is replacing execution really higher ROI than improving evidence and UI?
- Can external sessions recover after crashes and credential refreshes?
- Who enforces isolation when another daemon owns the subprocess?
- Can System remove the backend later without migrating Work semantics?
- Which measured result outweighs added dependency and support cost?
- Can the better solution be an **internally built replacement** instead?

## Sources and limitations

- [RES-0022](RES-0022-agent-workspace-landscape.md): capability survey and primary sources.
- [RES-0015](RES-0015-orca-study.md), [RES-0016](RES-0016-orca-study-round-2.md),
  [RES-0017](RES-0017-paseo-paradev-study.md): source-level follow-ups.
- [Control plane](../architecture/control-plane.md),
  [verification](../architecture/artifact-verification.md),
  [Host](../architecture/host.md),
  [Product Charter](../requirements/purpose.md).
- [Paseo SDK](https://github.com/getpaseo/paseo/blob/main/packages/client/README.md),
  [Orca](https://github.com/stablyai/orca),
  [ACP](https://agentclientprotocol.com),
  [OpenHands](https://github.com/OpenHands/OpenHands).

**No integration was installed, executed or benchmarked for this note.**
All external claims describe documented behavior as of 2026-11-27 and
need runtime/security validation before any implementation decision.
