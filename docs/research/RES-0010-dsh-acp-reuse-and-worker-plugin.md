---
id: RES-0010
type: research
status: active
date: 2026-11-08
summary: Compare pinned DSH ACP server and subagent client with System's WorkerPort and Rust bridge; identify safe reuse, independent plugin lifecycle, and measured admission gates.
related: [ADR-0001, ADR-0007, ADR-0011, RES-0005, RES-0009]
---

# DSH ACP reuse and an independently toggleable System Worker

**Research as of 2026-11-08; source inspected at
[DSH dsh-v0.2.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1),
the version pinned by System.** An external package having "ACP" in its name
does not establish that it implements the boundary System needs. Research
does not certify a live Claude/Codex login or promise performance gains.

## Decision question

Can an optional, disableable `@system/worker-acp` plugin reuse DSH's ACP
implementation instead of maintaining a second ACP client written in Rust?

**Answer:** DSH already ships both an ACP **server** and an ACP **client**,
but only the client overlaps the Rust bridge. Its public plugin API is a
**DSH subagent provider**, not a generic System WorkerPort. Reusing the entire
client provider would bring in DSH's parent-agent/Session runtime, contrary to
the System profile's deliberate exclusion of `dsh-agent` and agent loops.
Retain the selected, SDK-based Rust bridge as a small *optional* transport for
now, reuse DSH's `subprocess`, Cordis registration and plugin lifecycle, and
record the DSH alternative as a conformance comparison and possible later
replacement if a public low-dependency client seam becomes available.

This recommendation **does not require Rust to duplicate** DSH's process
manager, plugin registry, Work Controller or Artifact semantics. Future Rust
work remains subject to the [standards-first requirement](../requirements/purpose.md#product-wide-standards-and-interoperability-requirements).

## Compare the actual pinned DSH packages

| Package | Actual role | Public dependency/lifecycle seam | System decision |
| --- | --- | --- | --- |
| [`@deepseek-ai/dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1/packages/acp/acp) | ACP **server**, exposing DSH native agents over standard JSON-RPC stdio | `ctx.agents`, Sessions, LLM/MCP/approval, persistence; part of the ACP *agent* profile | Not a replacement for an ACP **client** Worker. Consider only if System wants to expose DSH agents to external editors. |
| [`@deepseek-ai/dsh-acp-app`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1/packages/bundle/acp-app) | Bundle that starts the above server over `dsh-base` | Own agent loop, model provider, session persistence, stdout-only protocol | Do **not** layer onto System's deliberately small `@system/bundle`. A separate profile is possible for a distinct use case. |
| [`@deepseek-ai/dsh-subagent-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp) | ACP **client** for one fresh child ACP process and session per run | registers `SubagentProvider` on `ctx.subagents`; injects `subagents`, `subprocess`; child invokes `initialize`, `session/new`, `session/prompt` | Closest reusable implementation. **Not plug-and-play** with System `WorkerPort` (no DSH parent Agent in System). Evaluate public integration seams before adopting. |
| [`@deepseek-ai/dsh-subprocess-local`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1/packages/subprocess/subprocess-local) | Managed subprocess groups, cancellation and teardown | Already mounted by System | **Reuse**, do not replace with a second Rust process supervisor. |
| [Cordis/DSH plugin lifecycle](https://github.com/deepseek-ai/deepseek-harness) | DI, named services, config composition and row `disabled` | Already used for `agents`, `fakes`, credentials and verifiers | **Reuse**: new `@system/worker-acp` row, **disabled by default**. |

### Why the DSH client is not immediately interchangeable

Source: [subagent ACP `src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp/src/index.ts)
and [`src/run.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp/src/run.ts).

- The provider registers on `ctx.subagents`, whose activation manager requires
  the exact currently live **parent DSH Agent** and session context. System's
  WorkController instead owns `WorkerRequest` and `WorkerResult` without
  a parent agent loop. Mounting the full agent stack simply to call ACP would
  duplicate responsibilities and widen the active dependency closure.
- The DSH client returns final/partial **assistant text** and a subagent stop
  reason, not exact System Artifact IDs, outputs slots, attempt provenance and
  verifier subjects. A System adapter would still have to materialize inputs,
  capture a worktree/output files, and reconcile effects and cancellation.
- It handles credentials and process supervision responsibly; its documented
  `permission` default is `reject`, which fits System's fail-closed baseline.
  It also supports `allow`, which **must not** be exposed by a System
  configuration until an explicit System policy/permission broker exists.
- This DSH package's public `start` method belongs to the *SubagentProvider*
  seam; importing private `src/run.ts` or copying that file into System is
  not standards reuse. A documented stable, low-dependency client API would
  change the tradeoff and should be re-evaluated.

### What DSH's ACP server can still teach us

The DSH ACP server has deliberate per-session ownership, serialized updates,
one in-flight prompt per session, capability negotiation, cancellation winning
prompt admission, quiescent close, persisted resume and no user-interface-only
extensions on the wire. Those are useful **protocol and failure-mode tests**
for System's adapter; they are not WorkController implementation tasks.

## Proposed plugin architecture

```text
System Host / Controller  (single Work authority)
   -> Capabilities.registerWorker(WorkerPort)
      -> @system/worker-acp   [Cordis plugin; disabled: true]
         -> shared TS workspace/Artifact/process helpers
         -> DSH subprocess service (range, cancel, exit)
         -> optional Rust ACP client bridge [official Rust SDK]
            -> installed ACP-speaking Claude/Codex agent
   -> @system/agents          [existing headless/Web paths, independent]
```

The plugin owns: ACP account config, ACP binary/agent discovery, authentication
selection, availability, provider-specific invocation, protocol results,
per-attempt observation, and cleanup of Worker registration. The System core
owns: Work/Attempt, capability routing, admission, policy, effect gate, exact
Artifacts, verification, terminal outcomes and replay.

The **Rust binary is not itself a Cordis plugin**: the TS adapter is.
Installing the binary or importing a TS package does not automatically enable
a Worker; the profile controls registration.

### What should move from PR #73's `@system/agents`

| Location | Move to | What stays shared |
| --- | --- | --- |
| `AccountConfig` ACP-only fields and `runtime === 'acp'` registration | `worker-acp` config + `apply()` | Existing `agents` status/login paths for headless/Web |
| ACP prompt-file creation, command resolution, auth mapping | `worker-acp` WorkerPort adapter | One per-attempt workspace and credential policy |
| `parseAcp`, `acpInvocation`, ACP progress mapping | `worker-acp` adapter | Provider-neutral WorkerRequest/Result; shared DSH spawner |
| Git worktree, input extraction, deterministic prompt, exact capture and cleanup | Shared TypeScript execution library | **Do not duplicate** across ACP and headless |
| Rust ACP SDK connection, session, permission request and stop reason | `acp-bridge` existing Rust executable | **Do not** implement ACP wire parser in System |
| `WorkerPort`, assignment, `gone` semantics, timeouts and policy | Controller or small shared execution primitive | Neither provider-specific code nor Rust owns policy |

## Required on/off contract and test gates

1. **Disabled by default:** Cordis row `worker-acp` installed but
   `disabled: true`; its `apply()` does not run and no worker ref,
   credential access, agent subprocess or Rust binary is required.
2. **Enable:** local profile enables `worker-acp` and explicitly lists
   accounts/capabilities, agent binary and credentials. Unknown/broken
   configuration reports unavailable rather than silently fallback.
3. **Disable:** stop new admissions **before** removing registered workers;
   drain or cancel in-flight attempts, reconcile uncertain process ranges,
   then unregister. `ctx.effect` cleanup is necessary but insufficient
   for safe hot reload. Until tested, require controlled drain/restart.
4. **Isolation:** stopping/removing the ACP plugin must not disable
   `@system/agents` or Website Workers; the reverse must also hold.
5. **Versioning:** pin Rust SDK and ACP v1, record bridge IPC schema/version,
   and compare DSH client's v1 conformance, stop-reason mapping, permission
   rejection, reconnect/EOF, cancellation and process exit.
6. **Security:** permissions default to reject, no automatic effect grants,
   no unreviewed ACP tool approvals; credentials are explicit, scoped and
   never printed in logs. Rust does not provide sandbox by itself.
7. **Result parity:** ACP `EndTurn` is **not** a Work success verdict;
   missing output file, failure, denied permission, cancelled/timeout and
   absent usage are handled identically to headless Workers where applicable.

## Evaluation matrix and future decision trigger

| Candidate | Reuse benefit | Extra cost/risk | Decision |
| --- | --- | --- | --- |
| DSH `dsh-acp` server | Standard ACP endpoint, persistent DSH agent sessions | Wrong protocol direction, entire DSH agent loop | **Do not mount** in System's Worker path |
| DSH `dsh-subagent-acp` via full subagent stack | Robust existing client cancellation, diagnostics, subprocess cleanup | Parent Agent/session dependency and a second orchestration layer | **Defer**; revisit if a minimal public client seam is offered |
| Official TypeScript ACP SDK directly in the plugin | Smallest language/runtime closure, no Rust bridge | Reopens ADR-0011's first-Rust choice | Valid fallback if Rust packaging overhead exceeds the benefit |
| Official Rust ACP SDK bridge + small Cordis plugin | Preserves first Rust component; clear protocol/client vs Work boundary | Cross-language IPC/binary build/release, another client implementation to maintain | **Current selected experimental implementation**, release-gated |

**Before promoting PR #73 from Draft**, demonstrate that the ACP plugin is
independent of the `agents` row and that the disabled default profile needs
no Rust toolchain. Do not call a passing Rust mock test proof of production
ACP session compatibility, credential isolation or safe hot-reload.

## Primary references

- [DSH pinned release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)
- [DSH ACP server README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/acp/acp/README.md)
- [DSH subagent ACP README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp/README.md)
- [DSH subagent provider source](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp/src/index.ts)
- [DSH subagent client source](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp/src/run.ts)
- [System WorkerPort](../../packages/work/src/registry.ts)
- [Rust ACP decision](../decisions/ADR-0011-rust-acp-worker-adapter.md)
