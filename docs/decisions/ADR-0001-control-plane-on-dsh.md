---
id: ADR-0001
type: decision
status: accepted
date: 2026-11-05
summary: Select System as a durable work control plane, DSH/Cordis as host and configurable plugin foundation, and two workflow-agnostic MVP proofs.
related: [RES-0003]
---

# Control plane on DSH/Cordis

## Context

The product must coordinate durable, replaceable Workers without building
a new general agent harness. It also needs a small active foundation and access
to community capabilities. Prior experience and independent reference audits
motivate keeping the core lean, but the new System makes its own decisions.

## Decision

1. **Product role:** System is a *control plane*, not a replacement LLM loop.
   It owns durable work identity, lifecycle, result/artifact references,
   cross-Worker handoff, authorization decisions, effect reconciliation,
   verification provenance and operator decision records.
2. **Chosen host:** use **DeepSeek Harness (DSH)/Cordis** for application boot,
   service composition, plugin lifecycle and the existing execution ecosystem.
   System domain services are implemented as DSH-compatible plugins/adapter
   components, not as a second independent plugin framework.
3. **Small active foundation:** explicitly select only required DSH/core
   services in the initial profile. Optional components use DSH's profile,
   bundle and per-row configuration. **Disable instead of deleting source**:
   installed but inactive plugins can be activated when required. Every
   enabled capability must declare and pass its dependencies.
4. **Community reuse:** compatibility with DSH plugins is a design goal;
   reuse available model/tool/Worker capabilities where their contracts,
   licensing, security and observed behavior are acceptable. A community
   plugin is not automatically trusted or allowed to bypass System policy.
5. **Agnostic MVP:** both **Software Engineering** and **Research** must work
   through the same System controller, artifact model and policy/effect
   semantics. Worker adapters, acceptance criteria and composition may differ,
   but there must be no second domain-specific core.
6. **Logical not necessarily physical split:** System control-plane services
   and DSH Worker execution may be colocated in one process. "Control plane"
   names responsibility ownership, not a mandatory distributed deployment.

The accepted [Product Charter](../requirements/purpose.md) is the current
purpose; [MVP requirements](../requirements/mvp.md) contain the proof contract.

## Alternatives considered

- **Build a full agent runtime:** rejected for MVP because it duplicates
  existing DSH tools, loops, plugin lifecycle and potentially community work.
- **Implement an independent plugin framework/host:** rejected as the primary
  path; it adds an additional composition and lifecycle system.
- **Use DSH as the work authority:** rejected: Worker conversation/session
  state and plugin configuration are not the canonical cross-Worker work
  ledger. The System control plane owns durable work semantics.
- **Run a dedicated distributed control-plane server:** deferred: separate
  deployment has no demonstrated MVP benefit.

## Consequences and constraints

- DSH compatibility and version pinning are explicit concerns.
- The active profile is kept minimal; keeping optional packages on disk does
  **not** make them safe or reduce their storage/build cost.
- Plugin disable/reload during in-flight work must drain, suspend or reconcile
  the affected run. DSH hot reload alone is not proof of safe work recovery.
- Plugins can run host code in-process. Pin versions and review supply chain,
  credentials, egress and permissions; trust boundaries require enforceable
  controls, not only a plugin name.
- A failed or unavailable optional plugin cannot silently disable core
  guarantees. Fail closed where safety dependencies are unmet.
- Detailed state machine, schemas, runtime packaging and adapter API remain
  open until verified by the two MVP workflows.

## Evidence and follow-up

See [research evaluation](../research/RES-0003-dsh-control-plane-evaluation.md)
for official DSH capability references, trade-offs and tests. Document any
material reversal as a new ADR rather than silently rewriting this rationale.
