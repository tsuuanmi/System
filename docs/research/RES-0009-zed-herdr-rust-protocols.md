---
id: RES-0009
type: research
status: active
date: 2026-11-08
summary: Compare Zed, Herdr and tmux mechanisms with System; evaluate ACP, MCP, IPC and observability standards, and gate selective Rust adoption on evidence.
related: [ADR-0001, ADR-0002, ADR-0003, ADR-0004, RES-0005, RES-0007]
---

# Zed and Herdr: interoperability, agent runtime and selective Rust adoption

**Desk research as of 2026-11-08; no code or benchmark has been run for this study.**
This is exploratory evidence and recommended experiments, **not** an accepted
architecture, implementation claim, or approval to migrate code. The canonical
System contracts remain in [control plane](../architecture/control-plane.md),
[workflow composition](../architecture/workflow-composition.md) and
[artifact verification](../architecture/artifact-verification.md).

## Question and short answer

Should System use Rust or replace parts with Zed/Herdr mechanisms and open
protocols? **Keep the DSH/Cordis-hosted TypeScript control plane.** Adopt
interoperability standards and test a read-only Herdr integration first. Treat
Rust as an implementation option for a separately bounded, demonstrably
problematic hot path, not as a goal. Do not introduce another authoritative
Work state machine, approval gate, scheduler or agent loop.

The relevant System principle is in [ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md):
System owns durable Work, Artifact handoff, policy, verification and effects;
DSH and Worker adapters own concrete execution. Runtime/session identifiers
are not Work or Artifact identities.

## What exists in System today (source-backed baseline)

| Concern | Current mechanism | Consequence for comparison |
| --- | --- | --- |
| Host and coordination | One long-lived Linux Host, commit lane, JSON-RPC 2.0 over NDJSON on a Unix socket; [host](../architecture/host.md) and [transport](../../packages/host/README.md) | Do not replace the Host with a second session server. |
| Work and replay | Work ID, immutable Workflow spec, events, receipts, restart reconciliation; [work](../../packages/work/README.md) | A terminal pane cannot be the source of truth. |
| Concurrent attempts | Ready-step scheduling and per-account slots; [work](../../packages/work/README.md) | Need evidence of a shortfall before adding scheduling. |
| Workers | Claude Code stream-json and Codex exec --json via DSH subprocess, per-attempt worktree/HOME, scoped process, budget and cancel; [agents](../../packages/agents/README.md) | Preserving structured output and process controls matters more than PTY UI. |
| Observability | LiveAttempt progress, work.show, work.events and work.watch notifications; [transport](../../packages/host/README.md) | Extend existing observation path, do not build a parallel Work ledger. |
| Security | System alone authorizes approval and publish; current MVP still lacks general worker sandbox/egress isolation; [control plane](../architecture/control-plane.md) | Neither Rust nor a multiplexer supplies policy isolation automatically. |
| Host framework | Small selected DSH/Cordis bundle; [bundle](../../packages/bundle/README.md) | Any integration should be optional and disabled by default. |

No measured System CPU bottleneck, parsing hot path or Rust-specific need was
identified in this desk review. Existing DSH subprocess and SQLite mechanisms
already cross native-code boundaries; a language rewrite must beat those
baselines rather than an imagined all-JavaScript implementation.

## External evidence: what to reuse and what not to confuse

| System to compare | Reusable lesson | Boundary / warning |
| --- | --- | --- |
| Zed (Rust, GPUI, crates) | Clear separation of UI, workspace, project and agent concerns; async UI; open editor-to-agent integration | GPUI is a desktop UI stack, not a headless Work Controller. |
| Zed External Agents | Agent Client Protocol (ACP): handshake, sessions, prompt/update/cancel, capability negotiation; editor keeps UI concerns | ACP is an **editor/client-to-agent session** protocol, not durable multi-Work orchestration or verification. |
| Zed Terminal Threads | Terminal and structured agent sessions are different integration modes | Do not mistake terminal screenshots for verified attempt results. |
| Herdr (Rust terminal runtime) | Multiplexed sessions, reconnect, cross-SSH machine view, agent status detection, CLI and Socket API, event subscriptions | Herdr is not a persistent Work/effect ledger; restart does not preserve original processes. |
| tmux | Mature panes, detach, scripting, hooks and control mode | Session orchestration and agent-state detection still need extra logic. |
| VS Code / Zed | IDEs can own editing and diff review without System becoming an editor | System should expose integrations rather than duplicate the IDE. |

**Protocol distinction:** Herdr's local socket API uses newline-delimited JSON
requests with id/method/params, and its published protocol/schema is
Herdr-specific. Do not label it ACP, MCP, or JSON-RPC 2.0 compliance solely
because envelopes look similar. Fetch the schema from the installed binary
(herdr api schema --json) and pin its tested version. Its events are hints;
resnapshot after reconnect, event loss or version changes.

**Source/architecture distinction:** Zed is written in Rust for a GPU-native
editor and multiple crate boundaries. That says little about performance of
System's LLM-/subprocess-/network-bound workloads. Herdr's strength is a
terminal/session runtime, not a substitute for verification or approval.

## Standards and compatibility map

| Protocol / contract | Where it belongs in System | Recommended action |
| --- | --- | --- |
| JSON-RPC 2.0 over local NDJSON | Current Host <-> CLI/MCP adapter | **Keep** existing API; version, validate and contract-test it. Use domain-specific methods rather than ACP names for Work. |
| MCP (2026-07-28 specification) | System tools/resources exposed to agents, e.g., existing system mcp entry | **Keep/evaluate conformance** to the chosen spec and SDK, without conflating the internal Host socket with an MCP transport. MCP stdio and Streamable HTTP are defined bindings; raw Unix socket is not automatically one. |
| ACP v1 | Editor/client <-> interactive coding agent session | **Explore as optional adapter** only if real IDE/interactive integration is required. Zed already supports external agents; System would need explicit session and permission mapping. |
| Herdr Socket API | Terminal/pane/session observation and optional operator attachment | **Try read-only connector** first; CLI wrappers for simple actions, raw socket for long-lived events. This is an implementation-specific API, not an interchangeable industry standard. |
| OpenTelemetry GenAI semconv | Traces/metrics for attempts, tools, models and workflows | **Explore additive instrumentation**; retain the authoritative Work event log and preserve model/usage provenance. Treat development-stage fields as versioned. Do not export secrets, prompts or artifacts by default. |
| LSP and DAP | Editor language intelligence and debugging | **Defer** unless System ships a language-editor client. Existing editors already implement them. |
| JSON Schema | Interop contracts, request/event validation | **Use when exposing new boundaries**; prefer generated contract tests over duplicated hand-authored schemas. |

ACP and MCP solve different problems: ACP conveys interactive agent session
operations, while MCP exposes tools/resources/prompts to an agent. Neither
transfers authority to approve, publish, retry verified effects, or alter
System's immutable Artifact IDs. Do not represent a Herdr status of
working/idle/blocked/done as System succeeded/failed/held.

MCP spec revision and agent SDK compatibility must be pinned for each spike;
a shared JSON-RPC encoding does not imply identical transport, method names,
authentication, permission, or cancellation semantics.

## Replace / adapt / keep matrix

| Existing System component | Candidate | Decision for now | Why / acceptance condition |
| --- | --- | --- | --- |
| Work Controller, commit lane, recovery and effect reconciliation | Rewrite in Rust or replace with Herdr | **Keep TypeScript** | Authoritative correctness semantics already implemented; rewriting creates migration and dual-owner hazards. |
| DSH/Cordis plugin host and account registry | Herdr plugins / Zed extensions | **Keep DSH** | Do not create a second mandatory plugin or execution framework. |
| Agent JSON streaming parsers and usage accounting | Rust parser | **Benchmark only** | Existing native JSON facilities; replace only on real throughput/CPU/RSS evidence and exact output parity. |
| DSH subprocess/process groups and per-attempt isolation | Rust sidecar/process supervisor | **Conditional spike** | Potential operational benefit for process trees, PTYs or cross-platform behavior, but must preserve cancel, timeout, credential isolation and crash recovery; Rust is not a sandbox. |
| Existing headless Claude/Codex Worker adapters | Herdr pane driver | **Keep headless default** | PTY/screen scraping weakens structured results and usage provenance. Consider interactive mode separately. |
| Work events and live attempts | Herdr agent-status/events | **Adapt via observer** | Feed a non-authoritative attention view; map explicit Attempt IDs, snapshot/reconcile after missed notifications. |
| Agent interoperability and UI handoff | ACP | **Explore optional boundary** | Prove a real Zed client use case; do not wrap the Work Controller as a fake conversation agent. |
| Artifact bytes, DSH SQLite | Rust store | **Keep** | No measured bottleneck or semantic gap; no dual databases or migrations just for language choice. |
| Documentation and workflow YAML compiler | Rust | **Keep** | Low-value rewrite; existing source/tests govern v1 semantics. |
| Zed GPUI/editor mechanisms | Direct reuse | **Do not adopt** | Not relevant to headless service, large dependency and licensing boundary. |

## Proposed experiments (not implementation in this PR)

### E0: Read-only Herdr observer (highest immediate value)

- Run pinned Herdr alongside System **without routing System Worker execution**
  into it. Verify CLI agent list, status updates, socket schema, reconnect and
  machine names on the actual target host.
- Subscribe to Herdr session/pane agent status events and separately request
  authoritative snapshots after connection/reconnect/gap; design a bounded,
  back-pressured observer. Only map a Herdr pane to a System Attempt when an
  explicit mapping was recorded; never infer by matching pane title or Git path.
- Integrate observations with System's existing work.show / work.watch
  projection or an operator-only view. Do not write Herdr events as Work
  terminal outcomes or accept them as evidence.
- Test broken socket, duplicate/dropped/reordered notifications, old/new
  versions, stopped Herdr, SSH loss and unrelated panes. Required result:
  System Work lifecycle is unchanged when Herdr is disabled or absent.
- Keep dependencies out of the default DSH bundle; define the minimal
  administrative trust required for Herdr and its plugins.

### E1: ACP interoperability feasibility, only with an actual client goal

- Determine whether the desired behavior is **view a live coding agent in
  Zed**, **launch an external agent from Zed**, or **inspect durable System
  Work**; these are different products. Zed already supports External Agents
  through ACP and terminal threads without any System rewrite.
- If needed, prototype a **separate ACP adapter** against a known-compatible
  interactive agent, pin an ACP version and test initialize, auth, new/load,
  prompt/update/cancel, capabilities, filesystem operations and user approval.
- Make it explicit that ACP session ID != System Work/Attempt ID and ACP
  permission prompts != System operator approval. Verify that the adapter
  cannot circumvent capability and effect policy.
- Go/no-go: demonstrates an IDE workflow not provided by existing native
  integrations; protocol conformance and safe cancellation pass.

### E2: Rust process/stream sidecar benchmark (only after a measured gap)

Compare the existing TypeScript/DSH subprocess path to a small isolated Rust
executable. Prefer a child-process boundary with a documented, versioned
stdio/Unix-socket protocol to an in-process N-API native addon at first:
failure isolation, straightforward opt-in and rollback. NAPI-RS is a later
option if measured boundary overhead dominates; it adds per-target builds.

- Collect baseline and candidate across identical machines/workloads:
  startup p50/p95, peak RSS, CPU-time, stream parse throughput, end-to-end
  Worker overhead, cancellations/kill time, resource leaks and build size.
- Include 1, 5 and 20 simultaneous **fake** attempts with fixed streams,
  repeated runs and a real Claude/Codex smoke test only if credentials are
  available. Model/network variability must not be reported as Rust speedup.
- Fault injection: parent/child crash, dropped pipe, huge/invalid JSON,
  backpressure, partial output, timeout, cancellation, process descendants,
  duplicate events and restart/settle of uncertain attempt slots.
- Maintain identical structured event/usage results, credential and worktree
  scope, System-owned effects, abort semantics and replay. No change to
  System's Work/event schema without an independently reviewed migration.
- **Suggested adoption gate (to validate, not a result):** at least a
  reproducible 25% reduction in a measured important bottleneck or a
  concrete correctness/portability gap that current native DSH facilities
  cannot address; no loss of safety, operational simplicity or test coverage.
  Report cold-build and cross-platform packaging cost.

### E3: Observability baseline

- Prototype OpenTelemetry GenAI traces as a **derived** view: trace/step
  association with Work ID, Attempt ID and Artifact ID, not replacements for
  those records. Use current semantic convention version.
- Treat token counts, cost estimates and served-model reporting with their
  existing provenance/unknown fields. Sample/redact; do not send prompt,
  credentials or artifact bytes externally by default.
- Evaluate usefulness with operator interventions and elapsed stall-detection
  time, not just prettier dashboards.

## Failure modes and constraints

1. **Two owners:** Herdr/ACP sessions must not take ownership of durable Work,
   effect reconciliation or approval. No silent sync of session state into
   Work success.
2. **Protocol look-alikes:** JSON over NDJSON is not interchangeable with
   JSON-RPC, ACP or MCP without exact methods, lifecycle and transport.
3. **Untrusted events:** Terminal agent-state detection is heuristic; missing,
   duplicated or late events need reconciliation. Prefer typed Worker results.
4. **Security:** Rust memory safety is not capability/credential isolation.
   Herdr plugins may run with user privileges. Keep worker and observer
   permissions narrow and preserve human-only approval.
5. **Build/deploy:** Rust changes the toolchain, CI matrix and binary
   distribution. TypeScript/DSH compatibility, release licensing and the
   host's current Linux constraints remain to be evaluated.
6. **Licensing:** Herdr is Apache-2.0; Zed source is primarily
   GPL-3.0-or-later, with marked Apache-2.0 components. Learning a public
   architecture or implementing ACP is different from copying GPL source.
   Audit dependencies and obtain license review before code reuse.
7. **No performance evidence:** Agent workloads may be I/O-bound. Do not
   infer speed or resource savings from implementation language alone.

## Decision recommendation and next actions

1. **Now:** keep current control plane, Host, Worker adapters and contracts.
   Use Herdr interactively outside the System execution path if useful.
2. **Next optional proposal:** run E0 read-only observer; capture before/after
   operator experience and failure cases. An accepted proposal/ADR is required
   before introducing a new active DSH capability.
3. **Conditional:** choose E1 only for a concrete IDE integration goal; choose
   E2 only after profiling. Do not make Rust a prerequisite for ACP/MCP.
4. **Do not:** rewrite core state, duplicate orchestration, add a desktop
   editor to System, or merge runtime implementation under this research PR.

**Unresolved evidence to collect:** current host CPU/RSS profiles under
representative workloads; Herdr socket version/support in the chosen binary;
concrete ACP use case; plugin security review; Rust sidecar packaging costs.
Any accepted result should be promoted to a Proposal or ADR; this research
file remains non-normative.

## Sources (accessed 2026-11-08)

- [System Host architecture](../architecture/host.md),
  [Host RPC contract](../../packages/host/README.md),
  [Worker runtime](../../packages/agents/README.md),
  [Work lifecycle](../../packages/work/README.md),
  [Control-plane ownership](../architecture/control-plane.md).
- [Zed developer architecture](https://zed.dev/docs/development) and
  [Zed Agent types](https://zed.dev/docs/ai/agents).
- [Zed External Agents and ACP](https://zed.dev/docs/ai/external-agents);
  [ACP v1 protocol](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx).
- [Herdr README](https://github.com/herdrdev/herdr) and
  [Herdr Socket API](https://herdr.dev/tui/docs/socket-api/).
- [MCP 2026-07-28 transport specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/index.mdx).
- [OpenTelemetry GenAI agent semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md).
- [NAPI-RS setup and distribution](https://napi.rs/docs/introduction/getting-started).
- [Zed licensing](https://github.com/zed-industries/zed#licensing),
  [Herdr license](https://github.com/herdrdev/herdr/blob/master/LICENSE).
