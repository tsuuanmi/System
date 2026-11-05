---
id: RES-0001
type: research
status: active
summary: Inventory the predecessor's documented capabilities and simplification evidence without claiming they are implemented in the new System.
---

# Research: baseline from system_1

**Evidence collected:** 2026-11-05. **Scope:** repository documentation and its claims; not an independent live runtime verification. This document is exploratory and is not a new System specification.

## Source of evidence

- [system_1 README](https://github.com/tsuuanmi/system_1/blob/main/README.md) describes a local-first, tool-agnostic AI Worker harness built on DSH core.
- [Predecessor architecture](https://github.com/tsuuanmi/system_1/blob/main/docs/architecture/README.md) describes plugin-based responsibility boundaries and a workflow/routing/kernel decomposition.
- [Predecessor purpose](https://github.com/tsuuanmi/system_1/blob/main/docs/requirements/purpose.md) motivates separate model quotas, website capabilities, locality, tier-aware routing, and worker-independent handoffs.
- [Predecessor lean-core proposal](https://github.com/tsuuanmi/system_1/blob/main/docs/proposals/0022-lean-core.md) discusses simplifying expensive development and review paths; its measured figures are historical observations tied to that installation, not new System benchmarks.
- [Predecessor research](https://github.com/tsuuanmi/system_1/blob/main/docs/research/lean-core-2026-11-01.md) identifies workflow overhead, approval waits, usage-accounting concerns, and little-used mechanisms as hypotheses for a leaner successor.

## Candidate capabilities to evaluate

The predecessor documents several classes of Worker (website, agent runtime, API/local model), capability routing, durable workflows, team-based review, a resource ledger, approvals, plugin hosting, an MCP server, a CLI, and a local operator UI. These are **inventory candidates**, not promises for System.

Potentially reusable concepts are the separation of guarantees from optional capabilities, evidence-carrying work artifacts, explicit data-egress control, and precise checks on an accepted result. Whether to reuse any implementation or dependency remains undecided.

## Differences and gaps

The new [System repository](../../README.md) currently contains only documentation scaffolding, not a Worker host, workflow engine, schema, command-line tool, or integration tests. All executable features and source-linked docs must be introduced with verified code. The predecessor's package statuses, roadmaps, release numbers, and old ADRs have no current authority here.

## Questions for follow-up

- Which minimum plugin contracts allow us to remove unneeded features rather than retain optional complexity?
- Which use cases justify both website Workers and local Workers?
- What proof of restart-safe effects and approval boundaries is sufficient for a first release?
- Which benchmark data can be reproduced on a pinned revision and hardware profile?

The next step is [[PROP-0001]], which discusses choices without making them binding.
