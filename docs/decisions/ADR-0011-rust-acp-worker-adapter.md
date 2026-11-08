---
id: ADR-0011
type: decision
status: accepted
date: 2026-11-08
summary: Select an optional Rust ACP Worker Adapter as System's first Rust component, reuse the official ACP Rust SDK, and preserve the existing provider-neutral WorkerPort and TypeScript/DSH control plane.
related: [ADR-0001, ADR-0002, ADR-0003, RES-0009, RES-0010]
---

# Rust ACP Worker Adapter as the first Rust component

## Context

The operator selected an ACP-capable Worker Adapter as System's **first Rust
component** (2026-11-08). System already routes work through the
provider-neutral [WorkerPort](../../packages/work/src/registry.ts).
Claude Code and Codex currently execute through structured headless CLI
adapters; the Website Worker has its own browser runtime. The
[product charter](../requirements/purpose.md) prioritizes existing standards
and maintained implementations rather than inventing replacements.

Zed demonstrates ACP-based External Agents alongside native terminal threads;
these are different execution/presentation paths. The
[ACP project maintains an official Rust SDK](https://github.com/agentclientprotocol/rust-sdk),
which can implement a client without reimplementing the ACP protocol.
This is a selection of the **first Rust integration boundary**, not a
benchmark result or an assertion that the Rust code already exists.

## Decision

1. **First Rust component:** implement a *separately deployable, opt-in*
   Rust ACP client/Worker bridge. Reuse the official
   `agent-client-protocol` SDK for ACP parsing, typed protocol messages,
   session operations, capability negotiation and version handling; do not
   fork or reproduce the ACP wire protocol without a documented gap.
2. **Single Work authority:** the TypeScript/DSH System Host and
   `WorkerPort` remain canonical for Work/Attempt IDs, scheduling,
   admission, policy, Artifact IDs, verification, effects, accounting and
   human-only approval. A thin TypeScript adapter may communicate with the
   Rust process using a small, versioned local contract. Do **not** expose
   ACP sessions as an alternative Work Controller or Work state store.
3. **Protocol boundary:** ACP belongs between the Rust ACP client and an
   ACP-capable interactive agent. The System-to-Rust IPC is a narrow
   System-owned adapter boundary, not a replacement for ACP/MCP, and must
   document why neither standard models System-specific attempt semantics.
   Prefer existing DSH subprocess/IPC facilities over a new transport stack.
4. **Interchangeability:** Claude/Codex agents may use the ACP path when
   tested and compatible. Existing structured headless adapters remain the
   default until parity is proven. A Website Worker need not speak ACP; it
   continues to obey `WorkerPort`. A Herdr/terminal observer is separate
   from this bridge, not a required dependency.
5. **Protocol versions:** start with a pinned stable ACP v1 and the official
   compatible SDK version. Negotiate only supported capabilities. Draft v2
   behaviors are explicitly opt-in and must not be presumed available.
   ACP `idle`/`requires_action`/turn completion is not System Work success,
   `held`, or an approval decision.
6. **Correctness and security gates:** propagate System cancellation,
   deadlines and process termination; preserve per-attempt workspace,
   credential scope, output Artifact capture, partial output, provenance
   and uncertain-attempt recovery. ACP permission requests cannot grant
   System publish/merge effects or operator approval. No new network service
   or plugin with broader privilege is mandatory for default operation.
7. **Build and release:** distribute/pin a Rust binary using the established
   development/release process, with documented toolchain/target support,
   compatibility handshake, reproducible builds, CI tests and a disable/
   rollback path. Do not make Rust a dependency for the existing headless
   MVP-0 profile until the optional adapter is admitted and proven.
8. **No automatic Rust expansion:** selecting this component does not
   authorize rewriting the Host, controller, workflow compiler, Artifact
   store, other Worker adapters or every performance-critical path in Rust.
   Further ports need specific correctness/compatibility evidence or
   measured performance gains and their own decision.

## Why this choice

- Official Rust SDK reuse offers a supported ACP implementation with typed
  protocol facilities and a narrower surface for interoperability testing.
  The [official TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
  is also viable: choosing Rust is the operator's explicit selection for
  System's first **bounded, optional cross-language component**, not a claim
  that TypeScript cannot implement ACP or that Rust is necessarily faster.
- A standalone process preserves failure isolation and existing DSH/Node
  responsibilities. A native Node addon or embedded library is not chosen
  without evidence that the process boundary is insufficient.
- Capability-based Worker interchangeability is a System invariant, not
  something delegated to the ACP session protocol.
- Adoption is motivated by a concrete interactive-agent integration and
  mature Rust SDK availability; Rust speed superiority is **not** asserted.

## Alternatives

| Alternative | Outcome | Reason |
| --- | --- | --- |
| Official TypeScript ACP SDK, no Rust bridge | Valid, simpler alternative; not chosen for this first Rust component | Maintained and standards-compliant; fewer build/IPC dependencies. Reconsider if optional Rust packaging or integration overhead outweighs the explicit Rust adoption goal. |
| Pinned DSH `@deepseek-ai/dsh-acp` server | Not selected as Worker adapter | Exposes **DSH Agents** to ACP clients; opposite direction from System initiating an external Worker. |
| Pinned DSH `@deepseek-ai/dsh-subagent-acp` client | **Defer, re-evaluate stable low-dependency API** | Implements ACP client but registers on DSH subagent runtime and requires live parent DSH Agent; integrating its full agent loop violates System's small Host boundary. |
| Reimplement ACP in bespoke TS or Rust | Rejected for initial adapter | Duplicates standard protocol/SDK; adds drift risk. |
| Migrate the TypeScript control plane to Rust | Rejected | Violates a stable authority boundary without evidence. |
| Require all Workers to expose ACP | Rejected | ACP does not describe browser or generic batch Worker semantics. |
| Use Zed or Herdr as the Worker/Work authority | Rejected | Their editor/terminal session lifecycle does not replace System Work outcomes. |
| Keep headless CLI only | Retained as default; insufficient alone | Interactive ACP interoperability is an explicit product goal. |

The exact DSH v0.2.2-rc.1 reuse comparison is recorded in
[RES-0010](../research/RES-0010-dsh-acp-reuse-and-worker-plugin.md).
ACP-specific TypeScript wiring belongs to the independently toggleable
`@system/worker-acp` Cordis plugin, not `@system/agents`.
Process management must continue to use DSH's existing subprocess service.

## Acceptance evidence before implementation is enabled

- The same frozen Task fixture produces System-compatible `WorkerResult`
  and stored Artifact outputs through existing headless and ACP adapters.
- Initialization, capability negotiation, authentication, session/new,
  prompt/update, cancellation, broken pipes, restart and reconnect have
  passing contract/fault tests against pinned ACP-capable agents.
- Permission-denial, credential isolation, publish/merge authority,
  timeouts, partial output, usage unknowns and lost-attempt handling remain
  correct. A terminal idle indicator never stands in for verification.
- `system doctor` exposes unavailable/disabled status explicitly; the
  existing CLI/Workers continue to work with no Rust binary installed.
- Benchmark cold start/RSS/CPU and packaging overhead for operational
  knowledge, **without** treating an arbitrary speedup as the prerequisite
  for this standards-integration choice.

**Implementation status:** accepted architectural choice only. This
documentation PR introduces no Rust code, Worker adapter, default profile
change, runtime tests or claim of ACP conformance. Any implementation should
be separately reviewed against this decision and [RES-0009](../research/RES-0009-zed-herdr-rust-protocols.md).

## References

- [Official ACP Rust SDK](https://github.com/agentclientprotocol/rust-sdk)
- [Official ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [ACP specification and Rust schema](https://github.com/agentclientprotocol/agent-client-protocol)
- [Zed External Agents](https://zed.dev/docs/ai/external-agents)
- [Zed Terminal Threads](https://zed.dev/docs/ai/terminal-threads)
