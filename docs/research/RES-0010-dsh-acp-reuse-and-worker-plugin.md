---
id: RES-0010
type: research
status: active
date: 2026-11-08
summary: Evaluate pinned DSH ACP packages and select an optional System WorkerPort plugin using the official ACP TypeScript SDK and DSH subprocess without a Rust bridge or parent agent loop.
related: [ADR-0001, ADR-0007, ADR-0011, RES-0005, RES-0009]
---

# DSH ACP reuse and an independently toggleable System Worker

**Pinned source evaluated:** [DeepSeek Harness dsh-v0.2.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1), the version already used by System. This document is the research rationale behind the provider-neutral ACP Worker plugin; real authenticated Claude/Codex compatibility is a separate test gate.

## Choice and reason

**Prefer a standalone, default-disabled `@system/worker-acp` Cordis plugin** with:
- the **official `@agentclientprotocol/sdk@1.4.0`** (stable ACP v1), matching pinned DSH's ACP client dependency;
- DSH's existing `ctx.subprocess` for managed process ranges, credentials scrub, bidirectional pipes, AbortSignal and termination;
- System's existing `WorkerPort`, capability registry, worktree/Artifact helper library, approval, verification and recovery.

**Remove the custom Rust bridge and its System-to-Rust IPC.** They duplicate a supported ACP SDK binding and add build/release/IPC complexity with no identified gap. This does not reject future Rust use when evidence supports it.

### What DSH already offers

| Pinned DSH package | Protocol direction / API | Decision |
| --- | --- | --- |
| [`@deepseek-ai/dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1/packages/acp/acp) | ACP **server**, exposes DSH agents to ACP clients | Not the Worker client. Useful only for a distinct external editor/server product goal. |
| [`@deepseek-ai/dsh-subagent-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp) | ACP **client** provider registered on `ctx.subagents`; accepts a parent DSH Agent/session | Closest upstream implementation, but its public plugin contract is not System's `WorkerPort`. |
| [`@deepseek-ai/dsh-subprocess-local`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1/packages/subprocess/subprocess-local) | Managed subprocess range, stdio pipes, cancellation, whole-range exit | Reuse directly; System already mounts it. |
| [Cordis plugin framework](https://github.com/deepseek-ai/cordis) | Dependency injection, effect cleanup, `disabled` composition | Reuse for independently toggleable Worker registration. |
| [ACP official TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) | Stable ACP v1 client, server, typed methods and NDJSON transport | Reuse directly, pinned to v1.4.0. No hand-written ACP JSON-RPC framing. |

### Why not simply mount `dsh-subagent-acp`?

The pinned [provider source](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp/src/index.ts)
injects `subagents` and `subprocess`, registering a `SubagentProvider`.
The [subagent activation manager](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent/src/index.ts) checks for an exact live **parent DSH Agent**.
System deliberately uses a durable Work Controller, not a nested DSH agent loop.

The lower-level `startAcpRun` helper exists in
[DSH's source run.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp/src/run.ts),
but the pinned package's public published entrypoint exports its plugin
(`lib/index.js`), not a standalone `startAcpRun` entrypoint. A private
source import or copied code would create a fragile DSH fork. Reconsider
direct DSH client reuse if upstream exposes a stable agent-independent
client transport API without the parent runtime dependency.

## Contract boundaries and authority

```text
System Host / Controller  (single durable Work authority)
  -> WorkerPort capability registry
      -> @system/worker-acp  [optional Cordis plugin; disabled by default]
         -> @system/worker-execution [shared TS Artifact/workspace helpers]
         -> DSH ctx.subprocess         [process ownership and termination]
         -> official @agentclientprotocol/sdk [ACP v1 client]
            -> installed ACP-compatible Claude/Codex/other agent
      -> @system/agents     [independent headless CLI and Website Workers]
```

| Event/fact | Owned by | Meaning |
| --- | --- | --- |
| `workId`, `attemptId`, assignment, policy | System Work Controller | Durable identity and authorization, never ACP session IDs. |
| ACP `initialize`, `session/new`, `session/prompt` | Official SDK via plugin | One interactive-agent protocol turn; does not authorize effects. |
| ACP tool permission request | ACP plugin | **Reject** by default. No automatic escalation to System operator approval. |
| ACP `end_turn` | ACP plugin | A turn completed; still require exact output files/tree and System verifier. |
| Managed process exit, timeout, cancellation | DSH subprocess + System Attempt | Only process-range exit proof clears a possibly running attempt. |
| Output Artifact ID and verifier verdict | System | Accepted evidence for Work progress and effects. |

Website Worker is still a valid System Worker without ACP support. The shared
Work Controller must never branch on "Claude" or "Codex" names.

## Why choose TS SDK over the former Rust adapter?

| Criterion | Direct official TypeScript SDK + DSH subprocess | Rust bridge + official Rust SDK |
| --- | --- | --- |
| ACP wire compliance | Official stable SDK | Official stable SDK |
| Process ownership | Existing DSH managed-range seam | DSH supervises a second child bridge which launches an agent child |
| WorkerPort integration | In-process TypeScript Cordis plugin | Extra local JSON/stdio IPC bridge |
| Deployment | Existing Node + pnpm lockfile | Cargo toolchain, native binary and target distribution |
| Startup, errors, observability | Direct typed SDK events | Bridge IPC translation, two process boundaries |
| User goal | Meets independent optional plugin requirement | No additional confirmed user-facing benefit |
| Choice | **Selected** | **Removed from PR #73** |

The selected design is not an attempt to maintain a parallel ACP protocol:
the SDK handles handshake, typed RPC messages, notifications and JSON-RPC
transport. System only owns its **domain adapter** from session results to
WorkerResult and exact Artifact IDs. Its lifecycle policy is a distinct
System concern, not a reimplementation of ACP.

## On/off and reliability acceptance gates

1. Default `worker-acp` row is installed but `disabled: true`. The disabled
   profile requires no ACP executable and registers no ACP Worker.
2. The ACP row can be enabled while `agents` is disabled, and vice versa;
   disabled rows do not read ACP credentials or start agent processes.
3. An unavailable agent executable or credential yields a visible reason,
   never a fallback to an unrelated vendor CLI.
4. ACP v1 handshake, prompt, streamed updates, tool permission refusal,
   incomplete sessions and cancellation are tested against an offline agent.
5. A valid `end_turn` without the requested Artifact fails the WorkerPort
   attempt; a rejected permission fails even after a nominal `end_turn`.
6. DSH subprocess signal/EOF teardown, lost PID, restart/recovery and
   uncertain process states are tested before enabling for production.
7. Use a controlled drain/restart for disabling a running plugin until
   active-attempt hot-toggle has explicit safety tests.
8. Pin ACP SDK v1.4.0 in the lockfile and fail closed on unsupported
   features. Do not assume experimental ACP v2, model tier selection or
   reliable token meter support from a generic ACP agent.

**Evidence boundary:** offline tests show protocol and adapter behavior,
not live authenticated agent compatibility, sandbox guarantees or safe
hot reload. Those need separate integration evidence before leaving Draft.

## Sources

- [Pinned DSH ACP client source](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp/src/run.ts)
- [Pinned DSH ACP provider source](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp/src/index.ts)
- [Pinned DSH package metadata](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp/package.json)
- [Official ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [System WorkerPort](../../packages/work/src/registry.ts)
