---
id: PROP-0002
type: proposal
status: draft
created: 2026-11-06
summary: Propose a staged post-MVP-0 roadmap prioritizing evidence quality, concurrency validation and reusable DSH capabilities before additional agents or a larger workflow engine.
evidence: [RES-0005, RES-0004, RES-0003]
related: [ADR-0001, ADR-0002, ADR-0003, ADR-0004]
---

# Proposal: post-MVP-0 roadmap and plugin strategy

**Status: DRAFT — priorities and module ideas are options for acceptance, not new ADRs.**
The current implementation evidence is from draft [PR #2](https://github.com/tsuuanmi/System/pull/2)
at `70994281`, stacked on documentation-only [PR #1](https://github.com/tsuuanmi/System/pull/1).
Its live GitHub publish test was recorded on 2026-11-06; no need to request
that already-reported authorization again. CI passed at that snapshot.
See [RES-0005](../research/RES-0005-plugin-reuse-audit.md) for the source-by-source audit.

## Product goal stays fixed

**Work persists. Workers change. Humans govern.** System remains a
**DSH-hosted durable Work control plane**; Work/Task is primitive; external
Workflow configs express domain-specific composition; exact Artifact IDs
carry handoff; independently selected verifier capabilities determine
accepted outcomes. The roadmap must improve *outcome reliability, verification
quality and provider interchangeability* — not maximize plugin count.

**Near-term priority:** product evidence and correctness, then minimal
capability additions. "Security is not an MVP-0 blocker" remains accepted;
this proposal does not reopen the sandbox decision or add isolation to
near-term exit gates. Accepted [ADR-0004](../decisions/ADR-0004-mvp-0-operating-decisions.md)
lists isolation and other items under MVP-1. Any permanent scope/order change
requires an explicit decision rather than an unannounced edit.

## Prioritization rule

For a capability to join the **active** System profile, require all of:
a concrete failed/missing use case, a service/contract ownership map,
a pinned source/version with compatibility assessment, automated behavior
tests, a measurable outcome/maintenance benefit and a rollback path.
Optional packages should stay disabled by default; no source deletion is
required to keep the active composition small.

| Priority | Candidate | Why now | Gate / no-go |
|---|---|---|---|
| **R0 — Verify MVP-0 baseline** | Confirm the latest PR #2 head, reproduce CI/real smoke evidence, record build/boot/latency/Work sizes, verify the reported throwaway GitHub publish | Have a stable comparator before adding plugins | Keep original semantics; don't mark live tests as rerun if only reading logs |
| **R0 — Storage/concurrency** | Multi-process stress and crash fixtures for same-Work operations; DSH SQLite patch/upstream assessment | A `busy_timeout` patch fixes one error class, not cache-coherency/fencing | A concrete lost update/double attempt is a release blocker; no daemon or new DB without reproduction |
| **R1 — Research evidence fidelity** | Add source/claim/report test suite, typed evidence bundle and optional `research.claim-support` verifier capability | Current citation checker can pass URLs and quotes without validating report claims | Unsupported claim with valid `sources.json` must not be incorrectly called verified; inconclusive is explicit |
| **R1 — Source Artifact provider spike** | Compare direct fetch against **DSH `ctx.web` + `web-fetch-http`**, store fetched evidence with Artifact ID | Build provenance that survives a changing website; reuse host service | Source digest/URL/time/redirect provenance stable and replay independent of website; no DSH agent-loop dependency |
| **R1 — Evaluation harness** | Repeatable deterministic fake and opt-in live scenarios for coding/research; structured scorecard | Current tests prove contracts, not quality distribution or model-upgrade regressions | Dashboard/board is not required; recorded results are comparable across providers/versions |
| **R2 — Extension proof** | Write an optional third **Verifier or Worker capability** outside the Work Core and toggle by config; test unsupported capability failure and later re-enable | Prove actual plugin extensibility beyond existing built-in rows | No controller source edit, no second plugin manager, no new Work authority |
| **R2 — Skills spike** | Compare provider-native skills to DSH Skill registry, possibly snapshot selected skills as Artifacts | Instructions reused across both domains without embedding them in YAML engine | Demonstrable outcome gain; direct DSH `tool-skill` is not assumed available to native CLI Workers |
| **R2 — Worker lifecycle/availability** | Explicit account availability, temporary quota/cooldown and refusal reason after observed failures | Two subscription-based adapters exist; routing currently takes first capable one | No speculative fleet scheduler; benefits measured as accepted Work / operator touches |
| **R3 — Controlled operational growth** | Concurrency/bounded independent steps, recovery explanations, artifact inspection, usage provenance, plugin drain/reload | Improve long-running/parallel workflows only after E2E demand | Preserve single Task primitive and deterministic recorded state |
| **R4 — Optional ecosystem** | LSP, Web search providers, peer/team plugins, Website Workers, board/UI, advanced model routing | Potential future workflows, no MVP proof yet | Defer until real workflow + contract gap + costed experiment |

## Candidate plugin mapping (not a mandate to create a package for each box)

**Keep as the stable base:** `@system/work`, `@system/artifacts`,
`@system/agents`, `@system/verifiers`, `@system/effects`, CLI,
DSH host storage/attachment/subprocess/credentials, and the disabled fake
provider. The existing registry already admits Worker, Verifier and Effect
providers; validate its extension contract before splitting packages.

**Potential additions (conditional):**

| Candidate capability | Existing base to reuse | Packaging decision / caution |
|---|---|---|
| `research.claim-support` | `@system/verifiers` contract and source/evidence Artifacts | Start as an optional verifier registered in existing package; split `verify-research` only if independent installation/config/lifecycle is needed. Evidence must bind both report and sources, not only the sources file. |
| `source.fetch` / `source.snapshot` | DSH `dsh-web` + `dsh-web-fetch-http`, Artifact Store | A System service/adapter returning immutable source Artifact IDs. External Claude/Codex tools need an explicit interface; mounting DSH `tool-web` alone is insufficient. |
| `eval.run` | System fake Workers/Verifiers, `work replay`, event/Artifact data | Prefer a test harness/CLI and fixtures before a long-running plugin or hosted dashboard. |
| `worker.*` third adapter | Existing `WorkerPort` in `@system/work`, DSH subprocess | Choose a **distinct** runtime only if it demonstrates replacement without controller changes. Avoid porting a separate agent loop. |
| `skill.snapshot` | DSH Skill registry / provider-native skill files | Pin selected instructions/metadata as an Artifact; native CLI must explicitly receive them. Optional, compare against zero extra plugin. |
| `work.explain` | Existing Work events, Artifact provenance, verifier evidence | Read-only CLI or library first. Do not create a second event log or persistent Work model. |
| `worker.availability` / `usage.observe` | Subscription account and tier fields in agents | Extend observed provider data without pretending it is an independent billing oracle. |
| `effect.*` | Existing versioned EffectPort and `git.publish` | Only add another effect with concrete workflow needs and reconciliation semantics. |

**Do not port or install as a Work authority:** System 1's monolithic Workflow,
board, agent-workers or browser account stack; DSH `jobs-local` (in-memory,
dies with host); DSH native subagent result as a drop-in usage/artifact
replacement; Dagu/Temporal as a second orchestration engine; a second DSH
plugin manager. Those can inform patterns or serve optional provider plugins
once a specific contract gap is demonstrated.

## Suggested implementation experiments, ready for an agent

### Experiment A — Research verdict quality (first)

- [ ] Add failing fixtures: (i) valid URL/quote but unsupported report claim;
  (ii) report cites source ID absent from `sources.json`; (iii) changed
  report with unchanged sources; (iv) quote removed from page;
  (v) two reports sharing source IDs with different claims.
- [ ] Introduce a typed **evidence-set Artifact** (report Artifact ID, sources
  Artifact ID, fetched source Artifact IDs and criteria revision). Define what
  the result proves; retain `inconclusive` when the evidence is inadequate.
- [ ] Keep the current `research.citation-check` behavior stable for old
  workflow versions; add a versioned verifier capability or bump accepted
  config only through a documented change.
- [ ] Compare deterministic structural validation and optional
  independent model-based claim support; keep model opinion as evidence,
  **not** an unquestionable `pass`.
- [ ] Demonstrate the Research YAML can select the new capability without
  modifying `WorkController`.

### Experiment B — Cross-process durability and DSH dependency (parallel to A)

- [ ] Stress two or more CLI hosts doing concurrent operations on the **same**
  and independent Works, including SIGKILL, cancellation, retries and effect
  outcomes. Check Work state equals replay and every accepted Artifact exists.
- [ ] Measure lock wait, retries, startup RSS/time, state growth and unknown
  remote effects. Compare before/after the pinned SQLite patch.
- [ ] Check current upstream DSH for the underlying fix; propose removing
  the local pnpm patch **only after** a versioned, reproducible test passes.
- [ ] If correctness fails, document smallest reproducer and compare:
  stricter per-Work fencing, a single state-owner process, or storage
  mechanism changes. Do not implement all alternatives.

### Experiment C — Actual external plugin extensibility

- [ ] Create one standalone optional provider with `CapabilityPort`
  registration and deregistration, built/pinned as a separate DSH-compatible
  row only if this is necessary for the test.
- [ ] Show Workflow admission with the capability disabled -> explicit
  missing-capability refusal; enabled -> successful result; no Work
  Controller changes; existing records remain readable.
- [ ] Run compatibility tests for verifier version, exact Artifact subject,
  output/criteria schemas, pending run and safe drain (the last is a later
  lifecycle test when scoped).
- [ ] Capture what changes to `@system/work` or DSH profile were needed.
  A successful test with a hardcoded provider import **does not prove**
  community plugin compatibility.

## Proposed measurement scorecard

Capture *per Work* and aggregate *per accepted Work*, separating reported
from independently observed numbers:

| Dimension | Proposed metric | Baseline / guard |
|---|---|---|
| Quality | accepted outcomes, false-pass fixtures, `inconclusive` and rejected ratios | Current verifier contract, not model self-report |
| Continuity | recovered interrupted Works, duplicate dispatch/effects, orphaned artifacts | Fault injection by specific boundary |
| Autonomy | human decisions and retries per accepted Work | Keep authority review meaningful; no arbitrary daily quota yet |
| Efficiency | p50/p95 by admission, Worker, verification, publish and total; storage/RSS growth | Compare pinned models, same tasks and source snapshots |
| Provider portability | same Work/Artifact/Verifier tests on different adapters | Distinguish tool availability and true output verification |
| Composition | enabled rows, dependencies, cold start, plugin enable/disable behavior | Only count active mounts, not installed packages |
| Usage | CLI-observed tokens, missing observations, subscription account limits | Do not claim an external billing oracle unless one exists |

No numeric product release threshold is accepted by this proposal. Historical
R1–R5 belong to external research; define denominators and run windows
before adopting them.

## Exit for proposing a new ADR

Promote an experiment into requirements/architecture only after: concrete
fixture, reproduced failure or measurable benefit, pinned source/DSH
version, test evidence, artifact/authority ownership, rollback and cost
assessment. Preserve the accepted Work/Artifact/Workflow/Verifier semantics.

**Review dependency:** PR #2 is currently stacked on PR #1. Updating this
documentation branch changes the base of PR #2 but **does not automatically
incorporate the new commits into PR #2's head**. Rebase or merge PR #1 into
PR #2 only when the operator chooses; do not modify the implementation
branch as a side effect of this research PR.

See the detailed [source-backed reuse audit](../research/RES-0005-plugin-reuse-audit.md).
