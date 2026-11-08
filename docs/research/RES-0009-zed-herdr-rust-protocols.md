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
protocols? **Keep the DSH/Cordis-hosted TypeScript control plane and one
provider-neutral WorkerPort.** Standardize the Worker-facing contract and
capability negotiation before choosing execution transports; test read-only
Herdr observation and ACP interoperability without demanding ACP from every
Worker. Treat
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
| ACP v1 (v2 draft) | Client <-> interactive agent session; Zed External Agents are a concrete client | **Prototype an optional ACP-capable Worker adapter** for interactive Claude/Codex, not a universal Worker protocol. Negotiate versions; keep v1 compatibility, gate v2 draft semantics. |
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

## Deep dive: provider-neutral Workers vs ACP, Terminal Threads and Herdr

**Goal:** System asks for a capability and a verifiable result, not for
"Claude", "Codex" or "a browser". The current [WorkerPort source](../../packages/work/src/registry.ts)
already routes by capabilities, accepts exact Artifact IDs, exposes an
AbortSignal/progress callback and returns typed WorkerResult. The
[agent adapters](../../packages/agents/README.md) still contain necessary
provider-specific launch/auth/parsing details. That division is correct;
the missing question is how to standardize **interactive session behavior**
and **observations** without adding a second Work Controller.

### Five boundaries, not one universal wire protocol

| Boundary | Canonical owner | Contract / lesson |
| --- | --- | --- |
| Intent, authorization and Work lifecycle | System Host/Controller | Work ID, immutable spec, budget, typed results, verification and effect receipts. **Never an ACP/terminal session.** |
| Worker execution | WorkerPort -> runtime adapter | One System request/result interface for Claude, Codex, Website Worker or future tools; capabilities decide routing. |
| Interactive agent session | Agent and ACP client if supported | Negotiated ACP session/prompt/update/cancel; ACP is a session wire protocol, not System's Worker contract. |
| Terminal/session host | Zed Terminal Thread, Herdr or plain PTY | Own terminal process, display and attach/reconnect; may lack typed completion/usage. |
| Observability/UI | System projection, IDE/terminal viewer | Derive attention/progress with source and confidence; never create an alternative authoritative Work state. |

A **Worker is not necessarily an ACP agent**. A browser worker can implement
System WorkerPort without ACP. A Claude/Codex account can implement WorkerPort
through structured headless JSON (today) or an ACP adapter (future). A
terminal thread is a *presentation/execution mode*, not proof the process
speaks ACP. The adapter handles provider quirks internally; the Controller
does not branch on provider strings.

Zed demonstrates this separation concretely in [agent paths](https://zed.dev/docs/ai/agents):
its native agent, ACP External Agents and Terminal Threads coexist under
one project/thread UI. [External Agents](https://zed.dev/docs/ai/external-agents)
own their own model, auth and tool configuration; a
[Terminal Thread](https://zed.dev/docs/ai/terminal-threads) runs the native
CLI/TUI and Zed owns only its UI/thread organization. Zed's agent-specific
permissions and MCP settings do not automatically apply to terminal threads.
System should copy this **responsibility boundary**, not copy its desktop
editor/GPUI stack or assume ACP handles every session type.

### Identity, sessions and durable outcomes

| ID or state | Meaning | May be shared as substitute? |
| --- | --- | --- |
| `workId` / `attemptId` | Durable System work and a concrete execution | No: authoritative in System. |
| `workerRef` | Selected account/capability offering | No: runtime identity, not work identity. |
| ACP `sessionId` | Agent-owned interactive conversation/session | No: may expire, resume or outlive an attempt. |
| Herdr pane/machine ID / terminal thread | Transport and presentation location | No: panes may be detached, recycled or misleading. |
| `ArtifactId` / verifier verdict | Immutable content and exact-subject evidence | Never inferred from a terminal or ACP idle state. |

Proposed **explicit, ephemeral mapping**:
`{workId, attemptId, workerRef, transportKind, externalSessionRef,
externalHost?, protocolVersion?, observedAt}`. Treat the session reference
as secret-adjacent metadata, never as an authorization token or Artifact ID;
make it optional for non-interactive Workers. Missing or stale mapping must
not be guessed from process names, pane titles or repository paths.

### System Worker contract: strengthen, do not replace

The existing TypeScript `WorkerPort` is already the common interface; the
following is **conceptual delta**, not implemented TypeScript or new API
schema:

```text
WorkerDescriptor {
  ref; capabilities[]; maxConcurrentAttempts;
  supportedModes[];  // batch, interactive; descriptive, not grant of authority
  observationSupport; // structured | heuristic | none
  sessionSupport;     // none | optional resume (capability negotiated)
}
run(WorkerRequest: pinned Artifact IDs, AbortSignal, progress) -> WorkerResult
observe?(attemptId) -> advisory live observations
attach?(attemptId) -> operator-accessible session reference, if available
gone?(attemptId) -> positive process-exit evidence or unknown
```

Keep `WorkerRequest` and `WorkerResult` **canonical and transport-neutral**.
Do not require every Worker to implement `attach`, `resume`, `ACP`, or token
metering it cannot provide. Missing usage remains unknown with provenance;
do not synthesize zero. Only an advertised capability may be relied on at
preflight. A runtime adapter normalizes provider output into typed slots and
preserves partial results on cancel/failure. Unsupported or unknown
capabilities must fail preflight rather than silently downgrade.

A separate `SessionAdapter` may be warranted for live interaction, but only
if experiments demonstrate more than one real implementation. Avoid a
duplicate plugin framework, generic session database or universal method
set beyond what System actually needs.

### The ACP detail System must get right

ACP [v1 protocol](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx)
uses JSON-RPC; `session/prompt` responds at turn completion and streams
`session/update` notifications. ACP
[v2 draft](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/migration.mdx)
changes prompt response into **acceptance**, while foreground lifecycle and
stop reason appear in `state_update` events. v2 explicitly distinguishes
`running`, `idle` and `requires_action`; background activity can still
continue after idle. Its
[July 2026 draft announcement](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/announcements/acp-v2-draft.mdx)
asks implementations to keep v1 and feature-flag v2. Treat v2 as a
**candidate**, not an already deployed universal contract.

Both ACP versions require handshake/capabilities and version-specific session
handling. An adapter must test the actual agent's advertised functionality,
including session creation/reload/resume, permission requests, cancel and
disconnect. Session-level `requires_action` is **not** the System `held`
decision: a tool permission or question may require operator interaction,
but cannot authorize `git.publish`, approve Work, or bypass System policy.
ACP cancellation must be reconciled with System AbortSignal, process scope
and durable attempt outcome; it is not equivalent to confirmed process exit.

### Three execution paths: select by capability, not provider

| Transport | Example | Strength | Limitation / policy |
| --- | --- | --- | --- |
| Headless structured CLI (current default) | Claude `stream-json`, Codex `exec --json` | Typed results, usage and deterministic capture boundaries | Limited interactive UI; continue to own process, timeout and worktree. |
| ACP-capable interactive client (experiment) | Claude/Codex via compatible agent/adapter | Structured session updates, permission requests, reconnect possibilities | Version/capability differences; needs result extraction and sandbox/approval parity. |
| Terminal/Herdr observer or attached PTY | Terminal Threads, Herdr pane | Native TUI, cross-host interaction, attention signals | Screen heuristics do not certify completion, usage or authority. |
| Browser Website Worker (existing) | ChatGPT web runtime | Can normalize results through WorkerPort with provenance | UI automation has weaker structural guarantees; no ACP requirement, explicit limits. |

One Worker can offer multiple modes. **Never silently switch modes**
mid-attempt or reuse terminal history as durable input: pin the adapter and
reported execution mode for the Attempt. Reassignment must create a new
Attempt ID with exact persisted Artifact inputs and policy, not assume
portable session transcripts.

### Observability and event semantics: what to copy from Herdr

[Herdr's agent detection](https://herdr.dev/tui/docs/agents/)
combines foreground-process detection, screen heuristics and integrations;
its [Socket API](https://herdr.dev/tui/docs/socket-api/) exposes a
versioned machine-readable schema (`herdr api schema --json`) and event
subscriptions. These are useful **observation patterns**, not a source of
truth. An unfamiliar prompt may be reported idle rather than blocked.
Operator actions must not be auto-authorized by a status heuristic.

Conceptual projection (not a proposed Work event schema):

| Incoming signal | Show in attention UI | Authoritative System transition? |
| --- | --- | --- |
| ACP v2 `requires_action` / v1 permission request | "Input needed" with session and source | **No**; only authorized decision path can hold/approve. |
| ACP `running` or Herdr `working` | "Active" (observed, timestamped) | No. |
| ACP `idle`, Herdr `idle/done` | "Possibly ready", inspect result | No; await WorkerResult and exact verifiers. |
| Herdr `blocked` inferred from screen | "Likely needs input", lower confidence | No. |
| WorkerResult + captured output Artifacts | Durable `observed` result | **Yes**, under current Work Controller gates. |
| Verifier verdict on pinned subject | Verified/rejected outcome | **Yes**, under System's policy. |

Every observation should include `source`, `timestamp`, external sequence
if available, confidence/typed-vs-heuristic marker, and linked Attempt when
verified. Detect stale/lost/duplicate/reordered notifications; resnapshot
on reconnect. Extend `LiveAttempts` and `work.watch` projections where
sensible, never persist terminal guesses as canonical replayable events.
Consider OpenTelemetry as an **export-only derived trace view**, with
prompts, secrets and Artifact bytes excluded by default; relevant
[GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)
remain in Development.

### Contracts, modules and language: concrete lessons

1. **Single authority, multiple ports:** Zed keeps UI/thread concerns apart
   from agent-specific runtimes. System should keep Work Controller, WorkerPort,
   SessionAdapter and observer/view as explicit boundaries. No second Host,
   scheduler, state machine, plugin engine, or privileged approval path.
2. **Contract before implementation:** document fields, capabilities,
   handshake, provenance, cancellation and unknown-state handling. Version
   schemas and add conformance/fault tests. Use the same WorkerPort tests for
   Claude/Codex/Website fakes, plus adapter-specific tests.
3. **Protocol negotiation, not protocol branding:** ACP is client-agent;
   [MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/index.mdx)
   is tools/resources/prompts; the Herdr Socket API is Herdr-specific; the
   internal Host is JSON-RPC/NDJSON. Shared encoding never implies
   interchangeable auth, semantics, or transport.
4. **Observation separate from outcome:** follow Herdr's useful
   attention/reconnect patterns, but favor structured events and current
   System result/verification contracts over heuristics.
5. **Rust follows measured need:** Zed's Rust modularity and Herdr's Rust
   session server are architectural examples. A Rust sidecar is justified
   only by a demonstrated process/stream bottleneck or correctness gap,
   with stable child-process/IPC contract, not by a language preference.

### Additional interoperability test matrix

| Scenario | Expected invariant |
| --- | --- |
| Same fixture Task via Claude/Codex structured adapters | Equal WorkerRequest/WorkerResult shape; differing provider details are provenance. |
| ACP v1 success and disconnect | Prompt lifecycle mapped correctly; no inferred Work success after lost connection. |
| ACP v2 draft prompt acceptance then error/idle | Acceptance is **not** success; v2 behind version+feature gates. |
| ACP asks permission; concurrent System approval held | Permission scoped only to agent tools, System effects still denied without human-authorized System decision. |
| Herdr reports idle while an approval dialog is visible | No automation types an answer or marks Work complete. |
| Website Worker missing tokens/session resume | Explicit unknown/unavailable, no fake token counts or assumed resume. |
| Cancel, timeout, crashed host, duplicate notifications | One Attempt outcome through Host; no double effect; unknown process kept uncertain until settled. |
| Adapter disabled or absent, SSH drops | Unrelated Workers/Works continue; no new mandatory plugin. |
| Handoff between different runtime types | New Attempt with pinned Artifact inputs, no implicit session transfer or credential propagation. |

**Acceptance gate:** the same System-owned authorization, Artifact result,
cancellation and verification invariants must hold with and without ACP,
Herdr or Rust. If the only benefit is a better human interface, keep the
integration in the operator/UI plane rather than replacing headless Workers.

## Replace / adapt / keep matrix

| Existing System component | Candidate | Decision for now | Why / acceptance condition |
| --- | --- | --- | --- |
| Work Controller, commit lane, recovery and effect reconciliation | Rewrite in Rust or replace with Herdr | **Keep TypeScript** | Authoritative correctness semantics already implemented; rewriting creates migration and dual-owner hazards. |
| DSH/Cordis plugin host and account registry | Herdr plugins / Zed extensions | **Keep DSH** | Do not create a second mandatory plugin or execution framework. |
| Agent JSON streaming parsers and usage accounting | Rust parser | **Benchmark only** | Existing native JSON facilities; replace only on real throughput/CPU/RSS evidence and exact output parity. |
| DSH subprocess/process groups and per-attempt isolation | Rust sidecar/process supervisor | **Conditional spike** | Potential operational benefit for process trees, PTYs or cross-platform behavior, but must preserve cancel, timeout, credential isolation and crash recovery; Rust is not a sandbox. |
| Existing headless Claude/Codex Worker adapters | Herdr pane driver | **Keep headless default** | PTY/screen scraping weakens structured results and usage provenance. Consider interactive mode separately. |
| Work events and live attempts | Herdr agent-status/events | **Adapt via observer** | Feed a non-authoritative attention view; map explicit Attempt IDs, snapshot/reconcile after missed notifications. |
| Interactive Worker interoperability and UI handoff | ACP | **Prioritize protocol spike** | Real use case: unified Worker behavior with Claude/Codex while keeping a generic System contract. Prove ACP mapping, Zed client integration only if needed; do not expose Work Controller as a fake conversation agent. |
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

### E1: ACP-capable Worker interoperability (P1, now a concrete user goal)

- The user requirement is **one provider-agnostic Worker contract**, with
  Claude Code/Codex interactive operation through ACP when supported, a
  terminal-thread fallback, and a Website Worker that obeys System's own
  Worker contract without pretending to speak ACP. Test this contract before
  replacing any existing headless Worker.
- Prototype an **optional ACP client-side adapter** against a pinned,
  known-compatible agent executable. Support ACP v1 first. Negotiate
  versions; gate v2 draft behind explicit feature flags. Test initialize,
  auth, session/new, load or resume according to version/capability,
  prompt/update, cancel, session loss, tool calls and user permission.
- Compare the same synthetic task through existing Claude/Codex JSON
  headless execution and ACP, including typed usage, output Artifacts,
  cancellation, sandbox/worktree boundaries, timeouts and failure cases.
- Keep ACP session ID distinct from Work/Attempt/Artifact IDs; ACP
  permission prompts are **not** System operator approval. Do not mark
  Work success from an ACP idle/stop event without valid WorkerResult
  and configured verification.
- Independently test an interactive-only terminal path with a selected
  Herdr/PTY pane and its limitations; do not assume its screen state is
  equivalent to ACP status or headless results.
- Go/no-go: same System WorkerResult semantics across supported adapters,
  explicit capability negotiation, no privilege bypass, usable interaction
  improvements over direct CLI/IDE paths, and no default-worker regression.

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
3. **Next parallel protocol experiment:** run E1 against a real interactive
   Claude/Codex ACP integration under the same System WorkerPort contract;
   preserve headless as default. Choose E2 only after profiling. Do not make
   Rust a prerequisite for ACP/MCP.
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
