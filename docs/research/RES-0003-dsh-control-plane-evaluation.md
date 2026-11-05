---
id: RES-0003
type: research
status: active
summary: Evaluate DSH/Cordis as the selected host for a minimal System control plane, plugin composition, lifecycle safety and cross-domain MVP proofs.
related: [RES-0002, ADR-0001]
---

# DSH-hosted control plane: evidence and experiments

**Research as of 2026-11-05; not implementation results.**
[ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md) selects the
DSH/Cordis foundation. This research evaluates **how to use that foundation
safely and minimally**, rather than reopening the host choice by default.

## External sources checked

Official DeepSeek Harness sources:

- [Architecture and profiles](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md):
  Cordis services/plugins, reversible registration effects, ordered profile
  and bundle layers, SDK-minimal exception.
- [Plugin packaging and install](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md):
  out-of-tree packages, bundle manifests, DSH-version requirements, patch
  precedence and whole-config replacement.
- [Composition/HMR tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/06-composition-and-hmr.md):
  per-entry disabled configuration retains entries without mounting.
- [Plugin manager](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md):
  installed-but-disabled plugins, changed profile state and HMR/restart
  behavior. Installed host code executes in-process, outside a workspace
  sandbox.
- [Application boot](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md):
  composition, plugin admission and compatibility constraints.
- [Shipped bundle catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/README.md):
  base-backed profiles and the separate sdk-minimal profile.

These are live upstream docs and may change. Pin a concrete DSH version/commit
for the implementation and reproduce all relevant behavior; this research
does not establish a tested compatibility version.

Additional protocol background:
[Model Context Protocol architecture](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/architecture/index.mdx).
MCP is a client/host/server integration protocol, not System's durable work
data model. Supporting MCP does not itself provide effect reconciliation.

## What DSH supplies, and what System must still prove

| Mechanism | Supported DSH model | Product question / risk |
|---|---|---|
| Plugin composition | Cordis services and declared dependencies | can all essential System guarantees live in a small required set? |
| Config-driven activation | disabled row keeps installed plugin, profile/bundle override | which config layer wins, what is actually mounted? |
| Community bundles | out-of-tree package + bundle patch, install/remove | trusted source, version pinning and dependency integrity |
| Runtime update | config HMR where enabled; otherwise restart | how to drain in-flight work and preserve coherent state? |
| SDK-minimal | explicit standalone SDK tree without dsh-base | is a custom minimal System profile viable without accidental base inheritance? |
| Models / agent execution | DSH model/agent/tool ecosystem | where does the System Worker adapter begin/end? |
| Policy/sandbox/credentials | DSH has plugins for these responsibilities | can they enforce System-specific trust at every effect boundary? |
| Durable work across Workers | not established by plugin existence | System-owned semantics and crash recovery tests required |

Do not confuse a **small active composition** with deleting optional source
or reducing installation footprint. The requirement is that unnecessary
plugins are *inactive by default*, but discoverable and enableable through
configuration when authorized.

## Trade-offs of control plane on DSH

**Benefits:** reuse host boot/service lifecycle and community components;
less custom agent runtime work; same controller can route across diverse
Workers; no need to run a separate microservice for logical separation.

**Costs and risks:** coupling to DSH API/versions and config precedence;
third-party in-process host code with substantial privilege; interactions
between plugin unload, in-flight work and persistent state; possibly duplicated
store/approvals if System carelessly builds a second layer. Config-only
disablement is not a security isolation mechanism.

**Decision consequence:** avoid building another universal plugin manager,
model loop, browser runner, full board, or workflow DSL. Add a small control
plane and thin adapters where existing DSH services do not satisfy explicit
System contracts.

## Experiment backlog before freezing modules

| Experiment | Method | Pass condition |
|---|---|---|
| E1 Composition minimum | build a DSH-backed profile with only needed services; inspect effective tree | code + research both run, optional capabilities not mounted |
| E2 Toggle and dependency | disable/re-enable a noncritical plugin via config, including higher-priority patch override | no code deletion, effective state and dependency failure visible |
| E3 Plugin lifecycle | kill host/disable adapter during active task | no lost work; controlled drain/hold or safe reconciliation |
| E4 Trust | install/execute only pinned, reviewed test plugin; try denied egress/privileged effect | unauthorized action is blocked at enforceable boundary |
| E5 Worker replacement | two adapters execute a comparable task through same work contract | Work Core code unchanged; artifacts and history remain usable |
| E6 Domain independence | execute Software Engineering and Research acceptance fixtures | same controller state machine and effects/evidence semantics |
| E7 Metering | compare cumulative session usage with independent oracle | no double count, uncertainty identified |
| E8 Runtime overhead | benchmark cold start, RAM, service count and time to accepted work | explicit baseline and only measured essential modules |
| E9 Degraded plugin | simulate missing/incompatible required plugin | dependent work fails closed while unrelated services can remain |

An independent integration experiment is still needed. The availability of
these DSH features is grounded in upstream documentation, but none of E1–E9
has been run for this fresh repository.

## Why two workflows matter

**Software Engineering** exercises mutable workspace/side effects: code
changes, tests, review and controlled landing.

**Research** exercises different capabilities and epistemic evidence:
external sources, citations, a report artifact and bounded evidence review.

If the controller needs a different engine branch for these, the Product
Charter's workflow generality has failed. Distinct Worker adapter, validation
policy, and task definitions are fine.

See the accepted [MVP requirements](../requirements/mvp.md) and current
[architecture](../architecture/control-plane.md). Historical reference
observations remain in [RES-0001](RES-0001-audit-baseline.md) and are not
measurements from this project.
