---
type: architecture
status: active
reviewed: 2026-11-05
---

# System control-plane architecture

**Status: selected target architecture, not an implemented system.**
System is a durable AI work **control plane** hosted on **DSH/Cordis**.
Its execution plane is existing agent/model/tool/Worker capabilities mounted
as DSH plugins or reached through adapters. See
[ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md) for the
decision rationale and [Product Charter](../requirements/purpose.md) for
purpose and philosophy.

## Logical topology

```text
Operator / CLI / MCP (candidate product entry points)
                    |
              System control plane
                    |
       +------------+------------+
       |            |            |
    Work state   Policy/effects   Evidence/verification
       |            |            |
       +------------+------------+
                    |
         capability + run admission
                    |
             DSH/Cordis host
           profiles / bundles / services
                    |
         active Worker/plugin adapters
           /                \
    Software Engineering    Research
         |                    |
      tools/models         tools/models
         \                    /
          artifact and event results
                    |
          System durable work state
```

This is a **responsibility diagram**. A single DSH host process with multiple
plugins is sufficient in principle; the diagram does not require a network
separation, additional daemon or independent scheduler.

## Ownership contract

| Concern | System control plane owns | DSH / execution plugin owns |
|---|---|---|
| Work | durable work ID, states, acceptance, handoff | run/session-local execution detail |
| Worker | admitted capabilities, assignment, external identity/attempt | concrete model loop, tools and provider-specific protocol |
| Artifacts | stable references, version/provenance and input/output contracts | production of bytes/patches/reports through tools |
| Effects | authorization, idempotency identity, reconciliation/uncertainty | permitted invocation of a concrete external operation |
| Verification | bind check to exact result, aggregate verdict/evidence | test runner, review Worker, citation checker |
| Usage | provenance, aggregation and validity flags | provider observations and local metering if available |
| Plugins | required capability contracts, safe admission/drain policy | installation, config layering, service lifecycle, enabled state |
| Operator | meaningful approval, override and decision records | presentation surfaces / notification transport |

DSH can supply persistence, approvals, credentials or sandbox plugins.
System SHOULD reuse them **where proven**; reuse does not transfer the
responsibility for correct work semantics, permission enforcement or safe
recovery. Do not build a duplicate store or approval gate without an identified
contract gap; identify the authoritative record before implementing one.

## Kernel / active-composition rule

An MVP profile mounts only what is required to run the two
[MVP workflows](../requirements/mvp.md#mandatory-end-to-end-acceptance-cases):
the System work services and the DSH hosting/execution capabilities needed
to satisfy their contracts. Every additional plugin has an explicit reason and
dependency. The complete list is determined by an actual profile dependency
audit, **not** by copying a reference bundle.

**Configuration-first plugin lifecycle:**

1. A plugin's package may be installed but excluded from active composition.
2. A profile/bundle or row config enables a capability; the authoritative
   effective configuration is inspected, not inferred from a UI toggle alone.
3. Disabling a capability blocks **new assignments first**.
4. Existing assignments must drain, migrate under a compatible adapter, or
   be safely stopped and reconciled before unloading invalidates their work.
5. Work state, effects and evidence survive plugin disable/reload; re-enable
   is checked for contract/version compatibility.
6. A required capability that fails to load makes dependent work unavailable
   and explicitly reported, never silently degraded into unsafe success.

DSH supplies layered profile/bundle composition; per-row disabled configuration
and optional hot reload exist. Their exact effective behavior, precedence and
compatibility must be tested against the **pinned DSH version**. A disabled
plugin is not a security sandbox, and source packages are retained even when
the plugin is inactive.

## Trust and safety boundary

A community plugin may execute code inside the DSH host process. Therefore:

- Installing a plugin is an operator-trusted administrative operation.
  Enforce source/version allowlists and dependency review before activation.
- Provider/Worker results are **untrusted evidence**, never self-granted
  authority. System policy gates admission and side effects.
- Sensitive credentials and data egress are constrained with actual host /
  tool controls and tests, not trust in the plugin label alone.
- If a plugin can bypass the policy/effect boundary, it cannot be admitted as
  an untrusted capability in the MVP. In-process composition alone does not
  enforce isolation.
- Disable and update operations are treated as lifecycle events with possible
  effects on in-flight work and persisted outcomes.

## Domain independence

Both domains use the **same core semantics**: work identity, attempt/result,
artifact references, policy/effect decisions, verification provenance and
terminal outcome. Workflow-specific behavior lives in data, Worker adapters,
tool choices and validation rules.

| Boundary | Software Engineering | Research |
|---|---|---|
| Input | task + repository scope | question + source/egress scope |
| Worker execution | coding adapter and tools | research adapter and search/tools |
| Result artifact | patch/commit or checked tree | report + source references |
| Verification | test results, review/landing policy | provenance and citation/claim checks |
| Outcome | approved result, optionally landing | accepted report |

Do not create a second engine just because the research workflow uses
different tools and result formats. This is a release-blocking MVP proof.

## Unfixed implementation details

The exact DSH bundle/profile, storage backend, restart protocol, schema and
Worker adapter API remain open. Boundary hypotheses and crash scenarios are
tracked in [draft boundary design](boundaries.md); alternative evidence and
test plan live in [RES-0003](../research/RES-0003-dsh-control-plane-evaluation.md).
