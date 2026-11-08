---
id: ADR-0011
type: decision
status: accepted
date: 2026-11-08
summary: Adopt an optional provider-neutral ACP WorkerPort plugin with the official TypeScript ACP SDK and DSH subprocess, without a Rust bridge or a second agent control plane.
related: [ADR-0001, ADR-0002, ADR-0003, RES-0009]
---

# Optional ACP Worker plugin: reuse SDK and DSH subprocess

## Context

System dispatches Work through the provider-neutral
[WorkerPort](../../packages/work/src/registry.ts), and remains the authority
for Work/Attempt IDs, exact Artifact inputs/outputs, verification, approvals
and effects. Claude Code and Codex already work through structured headless
CLI adapters; Website Worker uses browser automation. Interactive ACP-capable
agents are an optional transport, not a required capability for every Worker.

Research confirmed that pinned DSH `v0.2.2-rc.1` has:
- `dsh-acp`: an ACP **server** for exposing DSH agents, not the ACP client System needs;
- `dsh-subagent-acp`: an ACP **client**, but its published plugin seam uses
  `ctx.subagents` and requires a live DSH parent Agent;
- `dsh-subprocess-local`: a public, already-mounted service for managed
  process ranges, stdin/stdout pipes, cancellation and teardown.

The DSH ACP client pins the official
[`@agentclientprotocol/sdk@1.4.0`](https://github.com/agentclientprotocol/typescript-sdk).
System can use this stable ACP v1 SDK directly without a second agent loop.
An earlier proposal to introduce a Rust ACP client bridge was reconsidered
**before merge** because it duplicates standard SDK functionality and adds
binary packaging and System-to-Rust IPC without a demonstrated benefit.

## Decision

1. **One optional Cordis plugin:** `@system/worker-acp` independently
   registers System `WorkerPort` instances from explicit capabilities and
   account settings. The bundle installs it as **disabled by default**.
   `@system/agents` remains independently usable for headless/Website work.
2. **Official ACP client:** use the maintained **TypeScript SDK v1.4.0**
   and stable ACP v1 methods over the SDK's NDJSON stream. No copied DSH
   `run.ts`, fork, custom ACP JSON-RPC implementation or Rust bridge.
   ACP v2 stays unsupported unless a separate capability/version decision
   and compatibility tests justify it.
3. **DSH execution reuse:** launch the external ACP agent with
   `ctx.subprocess` using managed pipes and DSH process-range teardown.
   Reuse shared `@system/worker-execution` input materialization, worktree,
   process observation and exact Artifact capture.
4. **Canonical Worker contract:** only System assigns Work/Attempt IDs,
   routes capabilities, records Artifact IDs, checks output slots and applies
   verifiers and human approval. ACP session identity, prompt completion,
   `end_turn`, idle or permission prompts can never confer Work success,
   effect authority or a human approval verdict.
5. **Fail-closed permissions:** ACP agent tool permission requests are
   rejected by default. Account credentials are explicitly selected and
   passed through DSH's scrubbed-environment seam. The plugin is not a
   sandbox and cannot grant publish/merge or operator approval.
6. **Safe lifecycle:** unavailable agent executable/auth yields a visible
   reason with no fallback to another runtime. Disabled plugin registers no
   ACP workers and requires no ACP binary. Until proven otherwise, disable
   in-flight ACP work only after a controlled drain/restart; preserve
   uncertain process state and recovery evidence.
7. **Capability gaps are explicit:** model-tier selection, ACP v2, session
   resume, token budgets/usage and human permission brokerage are not
   advertised without corresponding tests and SDK support.
8. **No Rust prerequisite:** this change rescinds the unmerged selection of
   ACP as System's first Rust component. Future Rust work needs independent
   interoperability, correctness or measured performance justification.

## Alternatives

| Choice | Disposition | Reason |
| --- | --- | --- |
| Mount DSH `dsh-acp` server | Not selected | Opposite ACP direction (server rather than client). |
| Mount full DSH `dsh-subagent-acp` stack | Not selected now | Adds DSH parent Agent/subagent session machinery that System intentionally avoids. Reconsider if upstream offers a public independent client API. |
| Fork/copy DSH `startAcpRun` source | Rejected | Depends on private implementation and duplicates upstream maintenance. |
| Official Rust ACP SDK bridge | Removed from PR #73 | Extra process/IPC/build distribution with no evidence of required advantage. |
| Official TS ACP SDK + DSH subprocess | **Selected** | Standard protocol, existing execution seam, smaller dependency/lifecycle surface. |
| Require every Worker to speak ACP | Rejected | ACP describes interactive agent sessions, not generic browser/batch Work. |

## Release gates

- Same Work/Artifact contract as headless Workers, with exact output slots and
  no fake usage or result completion.
- Offline official-SDK handshake, session, prompt, permission denial and
  cancellation integration tests.
- Default-disabled profile and independent enabled plugin (with headless
  `agents` disabled), unavailable-binary diagnostics, stable WorkerRefs.
- Kill/restart/lost-attempt recovery and safe process-range teardown.
- Real isolated Claude/Codex ACP-agent smoke, including auth, before
  promoting the optional plugin from Draft to production.

This ADR is an accepted *architecture and library choice*, not a claim
that all release gates have already passed.

## References

- [Pinned DSH ACP client implementation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp/src/run.ts)
- [Pinned DSH ACP client package exports](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent-acp/package.json)
- [Official ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [ACP research](../research/RES-0009-zed-herdr-rust-protocols.md)
