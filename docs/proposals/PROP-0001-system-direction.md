---
id: PROP-0001
type: proposal
status: draft
created: 2026-11-05
summary: Establish System's goals, architectural questions, and first validation slice without assuming an implementation.
---

# Proposal: System direction

## Motivation

System aims to make it practical to assign AI work to capable Workers while maintaining clear control over permissions, cost, recovery, and result quality. These outcomes are a **proposal for review**, not existing product behavior.

## Proposed goals

1. **Right Worker, right job:** choose an appropriate Worker by capabilities, task needs, data locality, and budget rather than vendor name.
2. **Small, inspectable core:** keep correctness-critical contracts explicit and optional features replaceable. Complexity must justify its operational cost.
3. **Durable execution:** record useful work and handoffs so cancellation and restart can recover safely without unintended side-effect replay.
4. **Operator authority:** enforce bounded access, explicit data egress, approvals for sensitive actions, and trustworthy usage accounting.
5. **Verifiable quality:** evaluate latency, cost, reliability, reproducibility, and ease of maintenance with executable tests and reproducible measurements.

No specific host, plugin framework, programming language, provider, or deployment model is decided in this proposal.

## Decisions to make

- **Execution model:** which minimal abstractions distinguish a task, Worker, capability, result, and effect?
- **Plugin boundaries:** which capabilities should be independently installable, testable, and removable?
- **Worker contracts:** how to represent tool authorization, cancellation, resource limits, provenance, and usage consistently?
- **Recovery:** which data must persist, and which actions require reconciliation rather than automatic retry?
- **Trust:** how are local-only data, network egress, credentials, and permissions bounded?
- **Proof:** which vertical slice demonstrates useful work with the least infrastructure?

Accepted durable choices belong in new decision documents when warranted, with explicit alternatives and evidence.

## Suggested first vertical slice

1. Write a small, testable set of requirements and trust boundaries.
2. Implement one Worker behind a narrow interface, a durable task record, and a single client entry point.
3. Demonstrate start, completion, restart recovery, cancellation, denied side effects, and recorded usage.
4. Measure overhead, task latency, memory/CPU cost, and failure behavior with repeatable benchmarks.
5. Add further Worker classes and orchestration only when a verified use case requires them.

## Non-goals for this documentation PR

No runnable product or API is claimed. This PR does not choose the runtime, freeze a plugin interface, promise compatibility with unspecified interfaces, or assert untested performance.

## Exit criteria

The operator accepts or revises the scope, identifies initial architecture decisions and success measures, and assigns validation ownership. Only accepted parts become canonical requirements, architecture, and design.
